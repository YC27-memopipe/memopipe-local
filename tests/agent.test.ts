import { expect, test } from "bun:test";
import { AgentAuthError, createHandlers, findSendButton, gmailSearch, gmailSend, processOnce } from "../src/agent.ts";
import { ScreenpipeClient } from "../src/screenpipe.ts";

/** Fake Screenpipe: answers by path, records every call. No real mailbox or browser. */
function fakeScreenpipe(routes: Record<string, (body: any) => unknown | Response>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input.toString());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body });
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!route) return Response.json({ error: "not found" }, { status: 404 });
    const value = route(body);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  return { client: new ScreenpipeClient({ key: "test-key", fetcher }), calls };
}

const noWait = async () => {};

test("findSendButton picks Gmail's Send button and ignores schedule/options buttons", () => {
  const tree = [
    "[heading] Nouveau message",
    "[button] Options d'envoi supplémentaires #e43",
    "[button] Envoyer plus tard #e44",
    "[button] Envoyer ‪(Ctrl-Entrée)‬ #e42",
  ].join("\n");
  expect(findSendButton(tree)).toBe("e42");
  expect(findSendButton('- button "Send" [ref=e7]')).toBe("e7");
  expect(findSendButton("[button] Schedule send #e9\n[link] Send feedback #e3")).toBeNull();
});

test("gmail.search reads Gmail through Screenpipe IMAP, newest first, with the newest snippet", async () => {
  const { client, calls } = fakeScreenpipe({
    "GET /connections/imap/messages": () => ({ messages: [
      { id: 3, from: "karim@nimbus.example", to: "it@nimbus.example", subject: "Ancien", date: "Wed, 14 Oct 2026 09:00:00 +0200" },
      { id: 8, from: "karim@nimbus.example", to: "it@nimbus.example", subject: "Accès Inès Fabre", date: "Fri, 16 Oct 2026 09:00:00 +0200" },
    ] }),
    "GET /connections/imap/messages/8": () => ({ id: 8, snippet: "Prestataire :   pas de VPN prod.", body: "…" }),
  });
  const result = await gmailSearch(client, { query: "Inès Fabre", limit: "3" });
  expect(result.count).toBe(2);
  expect(result.first).toMatchObject({ id: 8, subject: "Accès Inès Fabre", snippet: "Prestataire : pas de VPN prod." });
  expect(calls[0].path).toBe("/connections/imap/messages?limit=3&mailbox=INBOX&query=In%C3%A8s+Fabre");
  await expect(gmailSearch(client, { query: " " })).rejects.toThrow("non-empty");
});

test("gmail.search surfaces Screenpipe's own message when IMAP is not connected", async () => {
  const { client } = fakeScreenpipe({
    "GET /connections/imap/messages": () => Response.json({ error: "Email inbox (IMAP) is not connected." }, { status: 401 }),
  });
  await expect(gmailSearch(client, { query: "x" })).rejects.toThrow("Screenpipe HTTP 401 on /connections/imap/messages: Email inbox (IMAP) is not connected.");
});

test("gmail.send fills Gmail compose in the Screenpipe browser, clicks Send once, redirects to the test inbox", async () => {
  let snapshots = 0;
  const { client, calls } = fakeScreenpipe({
    "POST /connections/browsers/owned-default/navigate": () => ({ ok: true }),
    "GET /connections/browsers/owned-default/snapshot": () => {
      snapshots++;
      if (snapshots === 1) return { url: "https://mail.google.com/mail/", title: "Gmail", tree: "[progressbar] Chargement" };
      if (snapshots === 2) return { url: "https://mail.google.com/mail/", title: "Gmail", tree: "[button] Envoyer #e42" };
      return { url: "https://mail.google.com/mail/#inbox", title: "Boîte de réception", tree: "[text] Message envoyé" };
    },
    "POST /connections/browsers/owned-default/act": () => ({ ok: true }),
  });
  const sent = await gmailSend(client, { to: "ines.fabre@presta.example", subject: "Vos accès", body: "Bonjour Inès" }, { browser: "owned-default", testInbox: "moi@gmail.com", sleep: noWait });
  expect(sent).toEqual({ to: "ines.fabre@presta.example", delivered_to: "moi@gmail.com", redirected: true });
  const url = new URL(calls[0].body.url);
  expect(url.searchParams.get("to")).toBe("moi@gmail.com");
  expect(url.searchParams.get("su")).toBe("[memopipe · test pour ines.fabre@presta.example] Vos accès");
  expect(url.searchParams.get("body")).toBe("Bonjour Inès");
  expect(calls.filter(c => c.path.endsWith("/act"))).toEqual([{ method: "POST", path: "/connections/browsers/owned-default/act", body: { ref: "e42", action: "click" } }]);
});

test("gmail.send refuses to click anything when Gmail asks to sign in", async () => {
  const { client, calls } = fakeScreenpipe({
    "POST /connections/browsers/owned-default/navigate": () => ({ ok: true }),
    "GET /connections/browsers/owned-default/snapshot": () => ({ url: "https://accounts.google.com/v3/signin", title: "Connexion", tree: "[button] Suivant #e2" }),
  });
  await expect(gmailSend(client, { to: "a@b.example", subject: "s", body: "b" }, { browser: "owned-default", sleep: noWait })).rejects.toThrow("not signed in");
  expect(calls.some(c => c.path.endsWith("/act"))).toBe(false);
});

test("processOnce claims a job on the hub, runs it locally and reports the result with the team token", async () => {
  const reports: { id: string; body: any; auth: string | null }[] = [];
  let queued = true;
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.headers.get("authorization") !== "Bearer mock-team-token") return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (path === "/api/agent/next") {
      const job = queued ? { id: 12, action: "gmail.search", args: { query: "Fabre" } } : null;
      queued = false;
      return Response.json({ job });
    }
    const match = path.match(/^\/api\/agent\/jobs\/(\d+)$/);
    if (match && request.method === "POST") { reports.push({ id: match[1], body: await request.json(), auth: request.headers.get("authorization") }); return Response.json({ ok: true }); }
    return new Response("Not found", { status: 404 });
  } });
  try {
    const { client } = fakeScreenpipe({
      "GET /connections/imap/messages": () => ({ messages: [{ id: 1, from: "k@n.example", to: "it@n.example", subject: "S", date: "2026-10-16" }] }),
      "GET /connections/imap/messages/1": () => ({ id: 1, snippet: "ok", body: "" }),
    });
    const link = { base: hub.url.origin, token: "mock-team-token", label: "test" };
    const done = await processOnce(link, createHandlers(client, { browser: "owned-default" }));
    expect(done).toMatchObject({ job: { id: 12, action: "gmail.search" }, ok: true });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: "12", auth: "Bearer mock-team-token", body: { ok: true, result: { count: 1, first: { subject: "S", snippet: "ok" } } } });
    expect(await processOnce(link, createHandlers(client, { browser: "owned-default" }))).toBeNull();
    await expect(processOnce({ ...link, token: "wrong" }, {})).rejects.toBeInstanceOf(AgentAuthError);
    await expect(processOnce({ ...link, base: "http://example.com" }, {})).rejects.toThrow("HTTPS or a loopback");
  } finally { hub.stop(true); }
});

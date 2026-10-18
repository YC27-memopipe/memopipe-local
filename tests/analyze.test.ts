import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ScreenpipeClient, fixtureRecords, localBase, normalizeRecords } from "../src/screenpipe.ts";
import { extractScenarios, parseDate } from "../src/extract.ts";
import { hubEndpoint, uploadScenario } from "../src/hub.ts";
import { analyze, timeBounds } from "../analyze/analyze.ts";
import type { RecordingFixture, Scenario } from "../src/types.ts";
const path = fileURLToPath(new URL("../fixtures/bob.json", import.meta.url));
const fixture: RecordingFixture = await Bun.file(path).json();
const records = fixtureRecords(fixture);
const scenarios = extractScenarios(records, fixture.provenance).scenarios;
const fakeFetch = (fn: (url: URL, init?: RequestInit) => Response | Promise<Response>) => ((input: any, init: any) => fn(new URL(String(input)), init)) as typeof fetch;
const json = (body: unknown, status = 200) => Response.json(body, { status });

test("synthetic fixture reconstructs T-1175 and T-1182 without draft permissions", () => {
  expect(scenarios).toHaveLength(2);
  expect(scenarios[0].ticket).toMatchObject({ id: "T-1175", requester: { contract: "cdi", team: "support" } });
  expect(scenarios[1].ticket).toMatchObject({ id: "T-1182", requester: { contract: "prestataire", end_date: "2027-01-15" } });
  expect(scenarios[1].expected).toEqual({ github: "read", "vpn-prod": "none", slack: "guest", expires_before: "2027-01-15", ticket_status: "done" });
  expect(scenarios[1].origin).toContain("FICTIVE");
  for (const scenario of scenarios) for (const e of scenario.evidence) expect(records.some(r => r.frame_id === e.frame_id && r.text.includes(e.quote))).toBe(true);
});
test("missing fields, console and invalid dates do not fabricate a scenario", () => {
  expect(parseDate("31/02/2027")).toBeUndefined();
  expect(extractScenarios(records.filter(r => !r.window_name.startsWith("Console"))).scenarios).toHaveLength(0);
  const broken = records.map(r => ({ ...r, text: r.text.replaceAll("15/01/2027", "31/02/2027") }));
  expect(extractScenarios(broken).scenarios).toHaveLength(1);
  expect(extractScenarios(broken).warnings).toHaveLength(1);
});
test("same user on multiple tickets is ambiguous", () => {
  const extra = { ...records[0], window_name: "T-9999 · Tickets Nimbus", frame_id: 9999 };
  expect(extractScenarios([...records, extra]).warnings.filter(w => w.includes("ambiguë"))).toHaveLength(2);
});
test("local URL boundary and safe remote hub", () => {
  for (const url of ["https://localhost:3030", "http://evil.example", "http://localhost@evil.example", "http://localhost:3030/path"]) expect(() => localBase(url)).toThrow();
  expect(localBase("http://[::1]:3030").hostname).toBe("[::1]");
  expect(() => hubEndpoint("http://example.com")).toThrow();
  expect(hubEndpoint("https://canary.example").pathname).toBe("/api/scenarios");
});
test("normalization handles nested and flat fields, rejects malformed response", () => {
  expect(normalizeRecords({ data: [{ "content.frame_id": 1, "content.timestamp": "2026-10-18T07:00:00Z", "content.window_name": "Nimbus", "content.text": "hi" }] })).toHaveLength(1);
  expect(normalizeRecords({ data: [{ content: { text: "no identity" } }] })).toEqual([]);
  expect(() => normalizeRecords({})).toThrow();
});
test("pagination keeps bounds and filters; OCR fallback per window; auth and redirects", async () => {
  const requests: URL[] = [];
  const client = new ScreenpipeClient({ key: "test-secret", fetcher: fakeFetch((url, init) => {
    requests.push(url); expect(init?.redirect).toBe("error");
    expect((init?.headers as any).Authorization).toBe("Bearer test-secret");
    if (url.searchParams.get("content_type") === "accessibility" || url.searchParams.get("offset") !== "0") return json({ data: [] });
    const wanted = url.searchParams.get("window_name")!;
    return json({ data: records.filter(r => r.window_name.includes(wanted)).map(r => ({ type: "OCR", content: r })) });
  }) });
  const f = await client.history("2026-10-17T07:30:00Z", "2026-10-18T07:30:00Z");
  expect(f.provenance).toBe("recorded"); expect(f.pages).toHaveLength(6);
  expect(requests.every(u => u.searchParams.get("start_time") === "2026-10-17T07:30:00Z")).toBe(true);
  expect(requests.some(u => Number(u.searchParams.get("offset")) > 0)).toBe(true);
});
test("HTTP failures, repeated pages and timeout are explicit errors", async () => {
  for (const status of [401, 403, 500]) {
    const c = new ScreenpipeClient({ key: "x", fetcher: fakeFetch(() => json({}, status)) });
    await expect(c.health()).rejects.toThrow(`HTTP ${status}`);
  }
  const repeated = new ScreenpipeClient({ key: "x", fetcher: fakeFetch(() => json({ data: [{ content: records[0] }] })) });
  await expect(repeated.history("2026-10-17T00:00:00Z", "2026-10-19T00:00:00Z")).rejects.toThrow("repeated");
  const offline = new ScreenpipeClient({ key: "x", fetcher: fakeFetch(() => { throw new Error("timeout"); }) });
  await expect(offline.health()).rejects.toThrow("unreachable");
});
test("empty search returns no scenarios and inactive capture is detected", async () => {
  const c = new ScreenpipeClient({ key: "x", fetcher: fakeFetch(u => json(u.pathname === "/health" ? { frame_status: "not_started", ui_recorder: { running: false } } : { data: [] })) });
  expect((await c.health()).captureActive).toBe(false);
  expect(fixtureRecords(await c.history("2026-10-17T00:00:00Z", "2026-10-18T00:00:00Z"))).toEqual([]);
});
test("consent refusal performs no history read or upload", async () => {
  let touched = false;
  const client = new ScreenpipeClient({ fetcher: fakeFetch(() => { touched = true; throw new Error("unexpected read"); }) });
  const r = await analyze({ since: "24h", dryRun: true }, { confirm: async () => false, log: () => {} }, { client });
  expect(touched).toBe(false); expect(r.sent).toBe(0);
});
test("only individually validated cases are sent once; raw frames never sent", async () => {
  const answers = [true, false, true]; const sent: Scenario[] = [];
  const r = await analyze({ since: "24h", fixtures: path, dryRun: false, hub: "https://canary.example", automation: "attribuer-acces" },
    { confirm: async () => answers.shift()!, log: () => {} }, { token: "team", upload: async (_base, _token, request) => { sent.push(request.scenario); expect(Object.keys(request).sort()).toEqual(["author", "automation_id", "scenario"]); return { id: "s1" }; } });
  expect(r.sent).toBe(1); expect(sent[0].ticket.id).toBe("T-1182"); expect(JSON.stringify(sent)).not.toContain("window_name");
});
test("dry-run validates but never uploads; invalid duration rejected", async () => {
  let uploaded = false;
  const r = await analyze({ since: "24h", fixtures: path, dryRun: true }, { confirm: async () => true, log: () => {} }, { upload: async () => { uploaded = true; return { id: "x" }; } });
  expect(r.validated).toHaveLength(2); expect(uploaded).toBe(false);
  expect(() => timeBounds("-1h")).toThrow(); expect(() => timeBounds("garbage")).toThrow();
});
test("hub sends token and validates receipt; HTTP errors fail", async () => {
  const request = { automation_id: "a1", author: "Bob" as const, scenario: scenarios[0] };
  const result = await uploadScenario("https://canary.example", "team", request, fakeFetch((_url, init) => {
    expect((init?.headers as any).Authorization).toBe("Bearer team"); expect(init?.redirect).toBe("error");
    expect(JSON.parse(init?.body as string)).toEqual(request); return json({ id: "s1" });
  }));
  expect(result.id).toBe("s1");
  await expect(uploadScenario("https://canary.example", "team", request, fakeFetch(() => json({}, 401)))).rejects.toThrow("HTTP 401");
  await expect(uploadScenario("https://canary.example", "team", request, fakeFetch(() => json({})))).rejects.toThrow("receipt");
});

test("complete transport flow: consent, health, paged search, save, validation and upload", async () => {
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "canary-e2e-"));
  const calls: string[] = []; const messages: string[] = [];
  const now = Date.now();
  const currentRecords = records.map((r, i) => ({ ...r, timestamp: new Date(now - 60000 + i * 1000).toISOString() }));
  const client = new ScreenpipeClient({ key: "local-key", fetcher: fakeFetch(url => {
    calls.push(url.pathname);
    if (url.pathname === "/health") return json({ frame_status: "ok", ui_recorder: { running: false } });
    const subset = currentRecords.filter(r => r.window_name.includes(url.searchParams.get("window_name")!));
    return json({ data: url.searchParams.get("offset") === "0" ? subset.map(content => ({ content })) : [] });
  }) });
  try {
    const result = await analyze({ since: "24h", save: `${dir}/recording.json`, dryRun: false, hub: "https://canary.example", automation: "access" },
      { confirm: async () => true, log: m => messages.push(m) }, { client, token: "team", upload: (base, token, request) => uploadScenario(base, token, request, fakeFetch(() => { calls.push("/api/scenarios"); return json({ id: `s${calls.length}` }, 201); })) });
    expect(result.sent).toBe(2);
    expect(calls[0]).toBe("/health"); expect(calls.filter(c => c === "/search")).toHaveLength(4);
    expect(calls.filter(c => c === "/api/scenarios")).toHaveLength(2);
    const saved = await Bun.file(`${dir}/recording.json`).json();
    expect(saved.provenance).toBe("recorded"); expect(saved.pages).toHaveLength(4);
    expect((await stat(`${dir}/recording.json`)).mode & 0o777).toBe(0o600);
    expect(messages.some(m => m.includes("screenpipe://frame/51234"))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("inactive live capture halts before history and unconsented results reject", async () => {
  const calls: string[] = [];
  const client = new ScreenpipeClient({ key: "x", fetcher: fakeFetch(url => { calls.push(url.pathname); return json({ frame_status: "stale", ui_recorder: { running: false } }); }) });
  await expect(analyze({ since: "24h", dryRun: true }, { confirm: async () => true, log: () => {} }, { client })).rejects.toThrow("Capture inactive");
  expect(calls).toEqual(["/health"]);
  const outside = new ScreenpipeClient({ key: "x", fetcher: fakeFetch(() => json({ data: [{ content: records[0] }] })) });
  await expect(outside.history("2025-01-01T00:00:00Z", "2025-01-02T00:00:00Z")).rejects.toThrow("outside the consented");
});

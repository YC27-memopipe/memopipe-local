import { validateScenario, type ScenarioUploadRequest } from "../../src/index.ts";

/** Loopback only. Test token and synthetic scenarios; no database or external actions. */
export function mockHub() {
  const requests: { authorized: boolean; body: ScenarioUploadRequest }[] = [];
  let mode: "ok" | "unauthorized" | "server-error" | "invalid-json" | "invalid-receipt" | "redirect" = "ok";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/api/scenarios" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const authorized = request.headers.get("authorization") === "Bearer mock-team-token";
    const body = await request.json() as ScenarioUploadRequest;
    requests.push({ authorized, body });
    if (!authorized || mode === "unauthorized") return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (mode === "server-error") return Response.json({ error: "Unavailable" }, { status: 503 });
    if (mode === "invalid-json") return new Response("not JSON");
    if (mode === "invalid-receipt") return Response.json({ accepted: true });
    if (mode === "redirect") return Response.redirect(new URL("/forbidden", request.url), 307);
    try {
      validateScenario(body.scenario);
      if (body.author !== "Bob" || body.automation_id !== "attribuer-acces" || Object.keys(body).sort().join() !== "author,automation_id,scenario") throw new Error("Invalid upload envelope");
    } catch { return Response.json({ error: "Invalid scenario" }, { status: 400 }); }
    return Response.json({ id: `mock-s${requests.length}` }, { status: 201 });
  } });
  return { url: server.url.origin, requests, setMode(value: typeof mode) { mode = value; }, stop() { server.stop(true); } };
}

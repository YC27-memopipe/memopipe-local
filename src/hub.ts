import type { ScenarioUploadRequest, ScenarioUploadResponse } from "./types.ts";
import { validateScenario } from "./validation.ts";

export function hubEndpoint(base: string): URL {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Hub requires HTTPS or a loopback HTTP origin");
  return new URL("/api/scenarios", url);
}
export async function uploadScenario(base: string, token: string, request: ScenarioUploadRequest, fetcher: typeof fetch = fetch): Promise<ScenarioUploadResponse> {
  validateScenario(request.scenario);
  if (!token.trim() || typeof request.automation_id !== "string" || !request.automation_id.trim() || request.author !== "Bob") throw new Error("Hub token, automation ID and author Bob required");
  const endpoint = hubEndpoint(base);
  let response: Response;
  try {
    response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ automation_id: request.automation_id, author: request.author, scenario: request.scenario }) });
  } catch { throw new Error("Hub unreachable, redirect refused or request timed out; delivery unconfirmed (no automatic retry)"); }
  if (!response.ok) throw new Error(`Hub HTTP ${response.status}; scenario not confirmed as received`);
  let body: ScenarioUploadResponse;
  try { body = await response.json() as ScenarioUploadResponse; } catch { throw new Error("Invalid hub receipt: expected JSON {id:string}"); }
  if (!body || typeof body.id !== "string" || !body.id) throw new Error("Invalid hub receipt: expected {id:string}");
  return body;
}

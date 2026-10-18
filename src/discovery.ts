import { ScreenpipeClient, fixtureRecords } from "./screenpipe.ts";
import { extractScenarios } from "./extract.ts";
import { validateScenario } from "./validation.ts";
import { hubOrigin } from "./hub.ts";
import type { RecordingFixture, Scenario } from "./types.ts";

export interface HistoryScope {
  consent: true;
  start: string;
  end: string;
  author: "Alice" | "Bob" | "Chloé";
}
export interface DiscoveryReport {
  format: "memopipe-discovery/v1";
  provenance: "recorded" | "synthetic-demo";
  start: string;
  end: string;
  cases: Scenario[];
  warnings: string[];
}

/** This is a bounded Nimbus observer, not a general-purpose screen-history agent. */
export async function discoverHistory(client: ScreenpipeClient, scope: HistoryScope, fixture?: RecordingFixture): Promise<DiscoveryReport> {
  if (scope.consent !== true || !["Alice", "Bob", "Chloé"].includes(scope.author)) throw new Error("Explicit history consent and a known author are required");
  const duration = Date.parse(scope.end) - Date.parse(scope.start);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 365 * 86400000) throw new Error("Invalid consented history interval (maximum 365 days)");
  if (!fixture) {
    if (!(await client.health()).captureActive) throw new Error("Capture inactive : relancer Screenpipe avant l’analyse.");
    fixture = await client.history(scope.start, scope.end);
  }
  const extraction = extractScenarios(fixtureRecords(fixture), fixture.provenance);
  const cases = extraction.scenarios.map(s => ({ ...s, origin: s.origin.replace(" · Bob · ", ` · ${scope.author} · `) }));
  return { format: "memopipe-discovery/v1", provenance: fixture.provenance, start: fixture.start_time, end: fixture.end_time, cases, warnings: extraction.warnings };
}

/** Only selected fields and literal evidence leave the PC; never raw Screenpipe records. */
export async function uploadDiscovery(base: string, token: string, author: HistoryScope["author"], report: DiscoveryReport, fetcher: typeof fetch = fetch) {
  if (!token.trim()) throw new Error("CANARY_TEAM_TOKEN is required");
  report.cases.forEach(validateScenario);
  const response = await fetcher(new URL("/api/discoveries", hubOrigin(base)), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ author, report }),
  });
  if (!response.ok) throw new Error(`Hub HTTP ${response.status}; discovery delivery unconfirmed (no automatic retry)`);
  const body = await response.json() as { id?: unknown };
  if (!Number.isSafeInteger(body?.id)) throw new Error("Invalid discovery receipt");
  return { id: body.id as number, url: new URL(`/decouvrir/${body.id}`, hubOrigin(base)).toString() };
}

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../analyze/analyze.ts";
import { ScreenpipeClient, fixtureRecords } from "../src/screenpipe.ts";
import { extractScenarios } from "../src/extract.ts";
import { MemoryAdapter, testAll, type RecordingFixture, type Scenario } from "../src/index.ts";
import { uploadScenario } from "../src/hub.ts";
import { mockHub } from "./helpers/mock-hub.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture: RecordingFixture = await Bun.file(`${root}fixtures/bob.json`).json();
const bob = extractScenarios(fixtureRecords(fixture), fixture.provenance).scenarios;

async function cli(args: string[], answers: string, token = "mock-team-token") {
  const process = Bun.spawn(["bun", "run", "canary:analyze", ...args], { cwd: root,
    env: { ...globalThis.process.env, CANARY_TEAM_TOKEN: token }, stdin: new Response(answers), stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => process.kill(), 5000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timeout); }
}

test("actual CLI sends only accepted fixture scenario to loopback HTTP hub", async () => {
  const hub = mockHub();
  try {
    const result = await cli(["--fixtures", "fixtures/bob.json", "--hub", hub.url, "--automation", "attribuer-acces"], "o\nn\no\n");
    expect(result.code).toBe(0); expect(result.stdout).toContain("1 scénarios envoyés");
    expect(hub.requests).toHaveLength(1); expect(hub.requests[0].authorized).toBe(true);
    expect(hub.requests[0].body.scenario.ticket.id).toBe("T-1182");
    expect(hub.requests[0].body.scenario.origin).toContain("FICTIVE");
    const source = await Bun.file(`${root}examples/v1.canary`).text();
    const runs = await testAll(source, [hub.requests[0].body.scenario], new MemoryAdapter());
    expect(runs[0].comparison.differences).toHaveLength(4);
  } finally { hub.stop(); }
});

test("CLI dry-run makes zero HTTP hub requests, consent denial and EOF fail closed", async () => {
  const hub = mockHub();
  try {
    const args = ["--fixtures", "fixtures/bob.json", "--hub", hub.url, "--automation", "attribuer-acces"];
    const dry = await cli([...args, "--dry-run"], "o\no\no\n");
    expect(dry.code).toBe(0); expect(dry.stdout).toContain("2 scénarios validés localement");
    const denied = await cli(args, "n\n"); expect(denied.code).toBe(0); expect(denied.stdout).not.toContain("demandes d’accès retrouvées");
    const eof = await cli(args, "o\n"); expect(eof.code).toBe(1); expect(eof.stderr).toContain("Entrée fermée");
    expect(hub.requests).toHaveLength(0);
  } finally { hub.stop(); }
});

test.each(["unauthorized", "server-error", "invalid-json", "invalid-receipt", "redirect"] as const)("CLI handles HTTP mock %s without retry", async mode => {
  const hub = mockHub(); hub.setMode(mode);
  try {
    const result = await cli(["--fixtures", "fixtures/bob.json", "--hub", hub.url, "--automation", "attribuer-acces"], "o\no\no\n");
    expect(result.code).toBe(1); expect(hub.requests).toHaveLength(1); expect(result.stdout).not.toContain("Reçu hub");
  } finally { hub.stop(); }
});

test("actual HTTP auth refusal and connection refusal", async () => {
  const hub = mockHub(); const url = hub.url;
  try { await expect(uploadScenario(url, "wrong-token", { author: "Bob", automation_id: "attribuer-acces", scenario: bob[0] })).rejects.toThrow("HTTP 401"); }
  finally { hub.stop(); }
  const result = await cli(["--fixtures", "fixtures/bob.json", "--hub", url, "--automation", "attribuer-acces"], "o\no\n");
  expect(result.code).toBe(1); expect(result.stderr).toContain("Hub unreachable");
});

test("full HTTP simulated Screenpipe → extraction → validation → hub → DSL → runner → comparison; save/replay", async () => {
  const hub = mockHub();
  const dir = await mkdtemp(join(tmpdir(), "canary-http-"));
  const now = Date.now();
  const records = fixtureRecords(fixture).map((r, i) => ({ ...r, timestamp: new Date(now - 60000 + i * 1000).toISOString() }));
  const searches: { type: string | null; offset: number }[] = [];
  const screenpipe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ frame_status: "ok", ui_recorder: { running: true } });
    if (url.pathname !== "/search") return new Response(null, { status: 404 });
    if (request.headers.get("authorization") !== "Bearer mock-screenpipe-key") return new Response(null, { status: 403 });
    const type = url.searchParams.get("content_type"), offset = Number(url.searchParams.get("offset"));
    searches.push({ type, offset });
    const matches = records.filter(r => r.window_name.includes(url.searchParams.get("window_name")!));
    return Response.json({ data: type === "accessibility" ? [] : matches.slice(offset, offset + 1).map(content => ({ type: "OCR", content })) });
  } });
  try {
    const result = await analyze({ since: "5m", save: `${dir}/recording.json`, dryRun: false, hub: hub.url, automation: "attribuer-acces" }, { confirm: async () => true, log: () => {} }, { client: new ScreenpipeClient({ base: screenpipe.url.origin, key: "mock-screenpipe-key" }), token: "mock-team-token" });
    expect(result.sent).toBe(2); expect(searches.some(s => s.offset > 0)).toBe(true); expect(searches.some(s => s.type === "accessibility")).toBe(true);
    const alice: Scenario = await Bun.file(`${root}fixtures/alice.json`).json();
    const scenarios = [alice, ...hub.requests.map(r => r.body.scenario)];
    const v1 = await testAll(await Bun.file(`${root}examples/v1.canary`).text(), scenarios, new MemoryAdapter());
    expect(v1.map(r => r.comparison.differences.length)).toEqual([0, 0, 4]);
    const v2 = await testAll(await Bun.file(`${root}examples/v2.canary`).text(), scenarios, new MemoryAdapter());
    expect(v2.map(r => r.comparison.differences.length)).toEqual([0, 0, 0]);
    const replay = await analyze({ since: "5m", fixtures: `${dir}/recording.json`, dryRun: true }, { confirm: async () => true, log: () => {} });
    expect(replay.validated).toEqual(result.validated);
    await expect(analyze({ since: "5m", fixtures: `${dir}/recording.json`, save: `${dir}/recording.json`, dryRun: true }, { confirm: async () => true, log: () => {} })).rejects.toThrow("EEXIST");
    expect(hub.requests).toHaveLength(2);
  } finally { screenpipe.stop(true); hub.stop(); await rm(dir, { recursive: true, force: true }); }
});

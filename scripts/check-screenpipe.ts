import { parseArgs } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenpipeClient, normalizeRecords } from "../src/screenpipe.ts";
import { timeBounds } from "../analyze/analyze.ts";

// Reads only the explicit recent window; prints metadata, never capture text or API keys.
const { values } = parseArgs({ options: { window: { type: "string" }, since: { type: "string", default: "5m" }, "page-size": { type: "string", default: "5" }, "cli-auth": { type: "boolean" } } });
if (!values.window) throw new Error("Provide --window <visible window title substring>; this command reads that window's recent observations.");
let key = process.env.SCREENPIPE_LOCAL_API_KEY;
if (!key && values["cli-auth"]) {
  const directory = await mkdtemp(join(tmpdir(), "canary-auth-"));
  try {
    const command = Bun.spawn(["bun", "x", "screenpipe@latest", "auth", "token"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
    void error; // May contain local details; never echo auth command output.
    if (code || !output.trim() || /\s/.test(output.trim())) throw new Error("Private Screenpipe auth retrieval failed; configure SCREENPIPE_LOCAL_API_KEY");
    key = output.trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (!key) throw new Error("Set SCREENPIPE_LOCAL_API_KEY or pass --cli-auth for private CLI retrieval");
const client = new ScreenpipeClient({ key });
console.log(JSON.stringify({ health: await client.health() }));
const { start, end } = timeBounds(values.since!);
for (const type of ["accessibility", "ocr"] as const) {
  const pages = await client.search(start, end, values.window, type, Number(values["page-size"]));
  const records = pages.flatMap(p => normalizeRecords(p.response));
  if (pages.some(p => (p.response as any).data.length) && !records.length) {
    const row = (pages.find(p => (p.response as any).data.length)!.response as any).data[0];
    console.log(JSON.stringify({ unnormalizedShape: { type: row.type, rowKeys: Object.keys(row), contentKeys: Object.keys(row.content ?? {}), fieldTypes: Object.fromEntries(Object.entries(row.content ?? {}).map(([key, value]) => [key, typeof value])), identifiers: { id: row.content?.id, frame_id: row.content?.frame_id, timestamp: row.content?.timestamp, window_name: row.content?.window_name } } }));
  }
  console.log(JSON.stringify({ type, start, end, pages: pages.map(p => ({ offset: p.offset, raw: (p.response as any).data.length, normalized: normalizeRecords(p.response).length })), frames: records.map(r => ({ frame_id: r.frame_id, timestamp: r.timestamp, textLength: r.text.length })), uniqueFrames: new Set(records.map(r => r.frame_id)).size }));
}
try {
  await new ScreenpipeClient({ key: "canary-invalid-test-key" }).search(start, end, values.window, "ocr", 1);
  console.log("Authentication check: invalid key accepted by local API (authentication may be disabled)");
} catch (error) { console.log(JSON.stringify({ invalidKeyResult: (error as Error).message })); }

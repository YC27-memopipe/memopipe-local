import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ScreenpipeClient, fixtureRecords } from "../src/screenpipe.ts";
import { extractScenarios } from "../src/extract.ts";
import { hubEndpoint, uploadScenario } from "../src/hub.ts";
import type { RecordingFixture, Scenario } from "../src/types.ts";

export interface AnalyzeOptions { since: string; fixtures?: string; save?: string; hub?: string; automation?: string; dryRun: boolean; }
export interface AnalyzeIO { confirm(message: string): Promise<boolean>; log(message: string): void; }
export function timeBounds(since: string, now = Date.now()) {
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (!match || +match[1] <= 0) throw new Error("--since must be a positive duration, e.g. 24h, 30m, 2d");
  const duration = +match[1] * ({ m: 60000, h: 3600000, d: 86400000 }[match[2]]!);
  if (!Number.isSafeInteger(duration) || duration > 365 * 86400000) throw new Error("--since is too large (max 365d)");
  return { start: new Date(now - duration).toISOString(), end: new Date(now).toISOString() };
}
export async function analyze(options: AnalyzeOptions, io: AnalyzeIO, deps: { client?: ScreenpipeClient; upload?: typeof uploadScenario; token?: string } = {}) {
  const { start, end } = timeBounds(options.since);
  if (!options.dryRun) {
    if (!options.hub || !options.automation || !(deps.token ?? process.env.CANARY_TEAM_TOKEN)) throw new Error("Provide --hub, --automation and CANARY_TEAM_TOKEN, or use --dry-run");
    hubEndpoint(options.hub);
  }
  io.log(`CANARY : ${options.fixtures ? `relecture de fixture ${options.fixtures}` : "historique Screenpipe local"}\nPériode : ${start} → ${end}\nFenêtres : Tickets Nimbus, Console des permissions\nSeuls les scénarios validés seront envoyés au hub${options.hub ? ` ${options.hub}` : ""}.`);
  if (!await io.confirm("Autoriser la lecture de ce périmètre ? (o/n) ")) { io.log("Annulé ; aucune lecture d’historique."); return { validated: [], sent: 0 }; }
  let fixture: RecordingFixture;
  if (options.fixtures) {
    fixture = await Bun.file(options.fixtures).json();
    fixtureRecords(fixture);
    io.log(`FIXTURE ${fixture.provenance === "synthetic-demo" ? "FICTIVE DE DÉMONSTRATION — aucune capture réelle" : "ENREGISTRÉE — provenance déclarée dans le fichier"}\nPériode du fichier : ${fixture.start_time} → ${fixture.end_time} (remplace --since).`);
  } else {
    const client = deps.client ?? new ScreenpipeClient();
    const health = await client.health();
    io.log(`Capture : frame_status=${health.frameStatus ?? "inconnu"}, ui_recorder.running=${health.uiRunning ?? "inconnu"}`);
    if (!health.captureActive) throw new Error("Capture inactive ou non vérifiable. Relancer Screenpipe puis vérifier /health, ou utiliser --fixtures explicitement.");
    fixture = await client.history(start, end);
  }
  if (options.save) {
    await mkdir(dirname(options.save), { recursive: true });
    // Never silently overwrite recordings; raw local history stays on this PC.
    await writeFile(options.save, JSON.stringify(fixture, null, 2), { flag: "wx", mode: 0o600 });
    io.log(`Fixture sauvegardée localement : ${options.save}`);
  }
  const extraction = extractScenarios(fixtureRecords(fixture), fixture.provenance);
  for (const warning of extraction.warnings) io.log(`À vérifier : ${warning}`);
  io.log(`${extraction.scenarios.length} demandes d’accès retrouvées`);
  const validated: Scenario[] = []; let sent = 0;
  for (const scenario of extraction.scenarios) {
    io.log(`\n${scenario.title}\n${JSON.stringify(scenario.ticket.requester)}\nAttendu : ${JSON.stringify(scenario.expected)}`);
    for (const e of scenario.evidence) io.log(`  [${fixture.provenance === "synthetic-demo" ? `frame fictive ${e.frame_id}` : `screenpipe://frame/${e.frame_id}`}] ${e.quote}`);
    if (!await io.confirm("Ce comportement est-il le bon ? (o = valider, n = rejeter) ")) continue;
    validated.push(scenario);
    if (!options.dryRun) {
      const receipt = await (deps.upload ?? uploadScenario)(options.hub!, deps.token ?? process.env.CANARY_TEAM_TOKEN!, { automation_id: options.automation!, author: "Bob", scenario });
      sent++; io.log(`Reçu hub : ${receipt.id}`);
    }
  }
  io.log(options.dryRun ? `${validated.length} scénarios validés localement ; mode --dry-run, aucun envoi.` : `${sent} scénarios envoyés au hub.`);
  return { validated, sent };
}
async function main() {
  const { values } = parseArgs({ options: { since: { type: "string", default: "24h" }, fixtures: { type: "string" }, save: { type: "string" }, hub: { type: "string" }, automation: { type: "string" }, "dry-run": { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) { console.log("bun run canary:analyze --hub <origin> --automation <id> [--since 24h] [--save local-data/bob.json] [--fixtures fixtures/bob.json] [--dry-run]"); return; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers = rl[Symbol.asyncIterator]();
  try {
    await analyze({ since: values.since!, fixtures: values.fixtures, save: values.save, hub: values.hub ?? process.env.CANARY_HUB_URL, automation: values.automation, dryRun: values["dry-run"]! }, {
      confirm: async message => {
        process.stdout.write(message);
        const answer = await answers.next();
        if (answer.done) throw new Error("Entrée fermée avant confirmation ; aucun consentement implicite.");
        return /^(o|oui)$/i.test(answer.value.trim());
      }, log: console.log,
    });
  } finally { rl.close(); }
}
if (import.meta.main) main().catch(error => { console.error(`CANARY : ${error.message}`); process.exitCode = 1; });

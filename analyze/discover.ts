import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { ScreenpipeClient } from "../src/screenpipe.ts";
import { discoverHistory, uploadDiscovery, type HistoryScope } from "../src/discovery.ts";
import { timeBounds } from "./analyze.ts";
import type { RecordingFixture } from "../src/types.ts";

async function main() {
  const { values } = parseArgs({ options: { hub: { type: "string" }, since: { type: "string", default: "24h" }, author: { type: "string", default: process.env.CANARY_AUTHOR ?? "Bob" }, fixtures: { type: "string" }, "dry-run": { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) { console.log("bun run canary:discover [--hub <origin>] [--since 24h] [--author Bob] [--fixtures <path>] [--dry-run]"); return; }
  if (!["Alice", "Bob", "Chloé"].includes(values.author!)) throw new Error("--author : Alice, Bob ou Chloé");
  const hub = values.hub ?? process.env.CANARY_HUB_URL;
  const token = process.env.CANARY_TEAM_TOKEN ?? "";
  if (!values["dry-run"] && (!hub || !token)) throw new Error("Renseigner CANARY_HUB_URL et CANARY_TEAM_TOKEN, ou utiliser --dry-run");
  const scope: HistoryScope = { consent: true, ...timeBounds(values.since!), author: values.author as HistoryScope["author"] };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers = rl[Symbol.asyncIterator]();
  const confirm = async (message: string) => {
    process.stdout.write(message);
    const answer = await answers.next();
    if (answer.done) throw new Error("Entrée fermée avant confirmation");
    return /^(o|oui)$/i.test(answer.value.trim());
  };
  try {
    console.log(`Découvrir les automatisations adaptées à ${scope.author}\nLecture locale : Tickets Nimbus et Console des permissions\nPériode : ${scope.start} → ${scope.end}${values.fixtures ? " (remplacée par celle de la fixture)" : ""}`);
    if (!await confirm("Autoriser cette lecture ? (o/n) ")) return;
    const fixture = values.fixtures ? await Bun.file(values.fixtures).json() as RecordingFixture : undefined;
    const report = await discoverHistory(new ScreenpipeClient(), scope, fixture);
    console.log(report.provenance === "synthetic-demo" ? "DÉMO FICTIVE : aucune capture réelle." : "Historique Screenpipe enregistré.");
    report.warnings.forEach(w => console.log(`À vérifier : ${w}`));
    console.log(`${report.cases.length} cas retrouvés ; aucune automatisation choisie à l’avance.`);
    for (const c of report.cases) {
      console.log(`\n${c.title}\n${JSON.stringify(c.ticket)}\nComportement observé : ${JSON.stringify(c.expected)}\nStatut done : objectif du workflow à confirmer, pas une preuve historique.`);
      for (const e of c.evidence) console.log(`[${report.provenance === "synthetic-demo" ? "frame fictive" : "frame"} ${e.frame_id}] ${e.quote}`);
    }
    if (values["dry-run"] || !report.cases.length) return;
    if (!await confirm("Transmettre ces champs et citations au hub pour chercher dans le catalogue ? Les références seront à valider avant les tests. (o/n) ")) return;
    const receipt = await uploadDiscovery(hub!, token, scope.author, report);
    console.log(`Recommandations : ${receipt.url}`);
  } finally { rl.close(); }
}
if (import.meta.main) main().catch(e => { console.error(`CANARY : ${e.message}`); process.exitCode = 1; });

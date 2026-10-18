import { parseArgs } from "node:util";
import { hostname } from "node:os";
import { ScreenpipeClient, type BrowserId } from "../src/screenpipe.ts";
import { AgentAuthError, createHandlers, processOnce, type HubLink } from "../src/agent.ts";
import { hubOrigin } from "../src/hub.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const time = () => new Date().toLocaleTimeString("fr-FR");

async function main() {
  const { values } = parseArgs({ options: { hub: { type: "string" }, author: { type: "string" }, browser: { type: "string" }, "test-inbox": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { console.log("bun run canary:agent [--hub <origin>] [--author Bob] [--browser owned-default|user-browser] [--test-inbox vous@gmail.com]"); return; }
  const hub = values.hub ?? process.env.CANARY_HUB_URL;
  if (!hub) throw new Error("Provide --hub or CANARY_HUB_URL");
  hubOrigin(hub);
  const token = process.env.CANARY_TEAM_TOKEN ?? "";
  if (!token.trim()) throw new Error("Set CANARY_TEAM_TOKEN to the hub's MEMOPIPE_TEAM_TOKEN");
  const browser = values.browser ?? process.env.CANARY_BROWSER ?? "owned-default";
  if (browser !== "owned-default" && browser !== "user-browser") throw new Error("--browser must be owned-default or user-browser");
  const testInbox = values["test-inbox"] ?? process.env.CANARY_TEST_INBOX ?? "";
  const author = values.author ?? process.env.CANARY_AUTHOR ?? "Bob";
  if (!["Alice", "Bob", "Chloé"].includes(author)) throw new Error("--author : Alice, Bob ou Chloé");

  const client = new ScreenpipeClient();
  const handlers = createHandlers(client, { browser: browser as BrowserId, testInbox });
  // HTTP headers are ASCII: keep the label plain.
  const link: HubLink = { base: hub, token, author, label: `${hostname()} (${author}, Screenpipe)`.replace(/[^\x20-\x7e]/g, "?") };

  console.log(`CANARY agent : découverte Screenpipe et actions locales\nUtilisateur : ${author}\nHub : ${hub}\nNavigateur Screenpipe : ${browser}`);
  console.log(testInbox ? `Envois Gmail redirigés vers ${testInbox}` : "Envois Gmail VERS LES VRAIS DESTINATAIRES (--test-inbox pour une boîte de test)");
  try {
    console.log(`Gmail en lecture (facultatif) : ${await client.connected("imap") ? "connecté" : "non connecté"}`);
  } catch { console.log("Gmail non disponible ; la découverte de l’historique reste utilisable."); }
  console.log("En attente d'actions… (Ctrl+C pour arrêter)\n");

  let offline = false;
  while (true) {
    try {
      const done = await processOnce(link, handlers);
      if (offline) console.log(`[${time()}] hub de nouveau joignable`);
      offline = false;
      if (!done) { await wait(1000); continue; }
      console.log(`[${time()}] #${done.job.id} ${done.job.action} : ${done.ok ? `ok (${(done.ms / 1000).toFixed(1)} s)` : `échec : ${done.error}`}`);
    } catch (error) {
      if (error instanceof AgentAuthError) throw error;
      if (!offline) console.log(`[${time()}] ${(error as Error).message} ; nouvel essai toutes les 3 s`);
      offline = true;
      await wait(3000);
    }
  }
}
if (import.meta.main) main().catch(error => { console.error(`CANARY agent : ${error.message}`); process.exitCode = 1; });

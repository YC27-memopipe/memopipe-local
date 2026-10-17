import type { Evidence, Scenario, ScreenRecord } from "./types.ts";
import { isDate, validateScenario } from "./validation.ts";

export function parseDate(value: string): string | undefined {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : value.trim();
  return isDate(iso) ? iso : undefined;
}
function field(text: string, label: string): string | undefined {
  return text.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*([^\\r\\n]+?)[ \\t]*$`, "mi"))?.[1].trim();
}
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const mappings = {
  github: { "lecture seule": "read", "écriture": "write", "aucun": "none", "non": "none" },
  "vpn-prod": { "oui": "access", "non": "none" },
  slack: { "invité": "guest", "membre": "member", "aucun": "none", "non": "none" },
} as const;
export interface Extraction { scenarios: Scenario[]; warnings: string[]; }
export function extractScenarios(records: ScreenRecord[], provenance: "recorded" | "synthetic-demo" = "recorded"): Extraction {
  const warnings: string[] = []; const scenarios: Scenario[] = [];
  const tickets = new Map<string, ScreenRecord[]>();
  const consoles = new Map<string, ScreenRecord[]>();
  for (const record of records) {
    const ticket = record.window_name.match(/\b(T-\d+)\s*·\s*Tickets Nimbus/);
    if (ticket) tickets.set(ticket[1], [...(tickets.get(ticket[1]) ?? []), record]);
    const email = record.window_name.match(/^Console des permissions\s*·\s*(.+)$/)?.[1].match(emailPattern)?.[0].toLowerCase();
    if (email && /Modifications enregistrées/.test(record.text)) consoles.set(email, [...(consoles.get(email) ?? []), record]);
  }
  const latest = (a: ScreenRecord[]) => [...a].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.frame_id - a.frame_id)[0];
  const emailTickets = new Map<string, number>();
  for (const frames of tickets.values()) {
    const t = latest(frames).text;
    const email = (field(t, "Email") ?? t.match(emailPattern)?.[0])?.toLowerCase(); if (email) emailTickets.set(email, (emailTickets.get(email) ?? 0) + 1);
  }
  for (const [id, frames] of tickets) {
    const ticket = latest(frames); const text = ticket.text;
    const email = (field(text, "Email") ?? text.match(emailPattern)?.[0])?.toLowerCase();
    const ticketType = field(text, "Type");
    if (ticketType !== "access_request") { warnings.push(`${id}: type de ticket absent ou non pris en charge`); continue; }
    const name = field(text, "Demandeur"), contractRaw = field(text, "Type de contrat")?.toLowerCase(), team = field(text, "Équipe");
    const contract = contractRaw === "cdi" ? "cdi" : contractRaw === "prestataire" ? "prestataire" : undefined;
    const endRaw = field(text, "Fin de mission"), end_date = endRaw ? parseDate(endRaw) : undefined;
    if (!email || !name || !contract || !team || (endRaw && !end_date && !/^(aucune|—|non)$/i.test(endRaw)) || (contract === "prestataire" && !end_date)) { warnings.push(`${id}: champs du ticket incomplets ou date invalide`); continue; }
    if (emailTickets.get(email)! > 1) { warnings.push(`${id}: plusieurs tickets pour ${email}, association ambiguë`); continue; }
    const candidates = consoles.get(email);
    if (!candidates?.length) { warnings.push(`${id}: aucune console enregistrée pour ${email}`); continue; }
    const consoleFrame = latest(candidates); const c = consoleFrame.text;
    const consoleEmail = field(c, "Email")?.toLowerCase();
    if (consoleEmail && consoleEmail !== email) { warnings.push(`${id}: email de console différent du titre de fenêtre`); continue; }
    const github = field(c, "GitHub"), vpn = field(c, "VPN production"), slack = field(c, "Slack");
    const ghLevel = mappings.github[github?.toLowerCase() as keyof typeof mappings.github];
    const vpnLevel = mappings["vpn-prod"][vpn?.toLowerCase() as keyof typeof mappings["vpn-prod"]];
    const slackLevel = mappings.slack[slack?.toLowerCase() as keyof typeof mappings.slack];
    const expiryRaw = field(c, "Expiration"), expiry = expiryRaw ? parseDate(expiryRaw) : undefined;
    if (!ghLevel || !vpnLevel || !slackLevel || (expiryRaw && !expiry && !/^(aucune|—|non)$/i.test(expiryRaw)) || (contract === "prestataire" && !expiry)) { warnings.push(`${id}: résumé enregistré incomplet ou expiration manquante/invalide`); continue; }
    const evidence: Evidence[] = [];
    for (const r of [ticket, consoleFrame]) {
      for (const line of r.text.split(/\r?\n/).filter(l => /^(Demandeur|Email|Type|Équipe|Fin de mission|Statut|Commentaire|GitHub|VPN production|Slack|Expiration|Modifications enregistrées)\s*[: ]/i.test(l.trim()))) {
        evidence.push({ frame_id: r.frame_id, quote: line.trim() });
      }
    }
    const scenario: Scenario = { title: `${id} · ${name} · ${contract}`, origin: `${provenance === "synthetic-demo" ? "DÉMO FICTIVE" : "Screenpipe"} · Bob · ${id}`,
      ticket: { id, type: "access_request", requester: { name, email, contract, team, ...(end_date ? { end_date } : {}) } },
      expected: { github: ghLevel, "vpn-prod": vpnLevel, slack: slackLevel, ...(expiry ? { expires_before: expiry } : {}), ticket_status: "done" }, evidence };
    try { validateScenario(scenario); scenarios.push(scenario); }
    catch { warnings.push(`${id}: scénario extrait invalide, vérifier les champs observés`); }
  }
  return { scenarios, warnings };
}

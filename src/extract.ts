import type { Evidence, Scenario, ScreenRecord } from "./types.ts";
import { isDate, validateScenario } from "./validation.ts";

export function parseDate(value: string): string | undefined {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : value.trim();
  return isDate(iso) ? iso : undefined;
}
const labels = ["Type de contrat", "de contrat", "Type", "Statut", "Demandeur", "Email", "Équipe", "Fin de mission", "GitHub", "VPN production", "Slack", "Expiration", "Commentaire"];
/** Read labelled spans without rewriting capture text, so every quote remains literal. */
function observedField(text: string, label: string): { value: string; quote: string } | undefined {
  const match = new RegExp(`${label}[ \\t]*:[ \\t]*`, "i").exec(text);
  if (!match) return;
  const start = match.index + match[0].length;
  const tail = text.slice(start);
  const boundary = new RegExp(`\\r|\\n|(?:${labels.join("|")})[ \\t]*:|Actions|Commentaires|Enregistrer|\\|?Auteur`, "i");
  const stop = tail.search(boundary);
  const value = tail.slice(0, stop < 0 ? tail.length : stop).trim();
  if (!value) return;
  const valueOffset = tail.indexOf(value);
  return { value, quote: text.slice(match.index, start + valueOffset + value.length) };
}
function field(text: string, label: string): string | undefined { return observedField(text, label)?.value; }
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
  const consoleLinks = new Map<string, Set<string>>();
  for (const record of records) {
    const ticket = record.window_name.match(/\b(T-\d+)\s*·\s*Tickets Nimbus/);
    if (ticket) tickets.set(ticket[1], [...(tickets.get(ticket[1]) ?? []), record]);
    const email = record.window_name.match(/^Console des permissions\s*·\s*(.+)$/)?.[1].match(emailPattern)?.[0].toLowerCase();
    if (email && /Modifications enregistrées/.test(record.text)) {
      consoles.set(email, [...(consoles.get(email) ?? []), record]);
      // A masked ticket email can only be joined through an explicit captured console→ticket link.
      for (const match of record.text.matchAll(/\bTicket[ \t]+(T-\d+)(?![-\d])/g)) {
        const links = consoleLinks.get(match[1]) ?? new Set<string>(); links.add(email); consoleLinks.set(match[1], links);
      }
    }
  }
  const latest = (a: ScreenRecord[]) => [...a].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.frame_id - a.frame_id)[0];
  const emailTickets = new Map<string, number>();
  const identities = new Map<string, { email?: string; fromConsole: boolean }>();
  for (const [id, frames] of tickets) {
    const t = latest(frames).text;
    const raw = field(t, "Email");
    const masked = raw?.toLowerCase() === "[email]";
    const links = consoleLinks.get(id);
    const email = masked ? (links?.size === 1 ? [...links][0] : undefined) : (raw ?? t.match(emailPattern)?.[0])?.toLowerCase();
    identities.set(id, { email, fromConsole: masked });
    if (email) emailTickets.set(email, (emailTickets.get(email) ?? 0) + 1);
  }
  for (const [id, frames] of tickets) {
    const ticket = latest(frames); const text = ticket.text;
    const identity = identities.get(id)!; const email = identity.email;
    if (identity.fromConsole && !email) { warnings.push(`${id}: email masqué sans lien de console unique, association ambiguë`); continue; }
    const ticketType = field(text, "Type");
    if (ticketType !== "access_request") { warnings.push(`${id}: type de ticket absent ou non pris en charge`); continue; }
    // Some redacted captures consume the word "Type" immediately after [EMAIL].
    const name = field(text, "Demandeur"), contractRaw = (field(text, "Type de contrat") ?? (identity.fromConsole ? field(text, "de contrat") : undefined))?.toLowerCase(), team = field(text, "Équipe");
    const contract = contractRaw === "cdi" ? "cdi" : contractRaw === "prestataire" ? "prestataire" : undefined;
    const endRaw = field(text, "Fin de mission"), end_date = endRaw ? parseDate(endRaw) : undefined;
    if (!email || !name || !contract || !team || (endRaw && !end_date && !/^(aucune|—|non)$/i.test(endRaw)) || (contract === "prestataire" && !end_date)) { warnings.push(`${id}: champs du ticket incomplets ou date invalide`); continue; }
    if (emailTickets.get(email)! > 1) { warnings.push(`${id}: plusieurs tickets pour ${email}, association ambiguë`); continue; }
    const candidates = consoles.get(email);
    if (!candidates?.length) { warnings.push(`${id}: aucune console enregistrée pour ${email}`); continue; }
    const consoleFrame = latest(candidates); const c = consoleFrame.text;
    const ticketLink = new RegExp(`\\bTicket[ \\t]+${id}(?![-\\d])`);
    if (identity.fromConsole && !ticketLink.test(c)) { warnings.push(`${id}: la dernière console enregistrée n'est pas liée à ce ticket`); continue; }
    const consoleEmail = field(c, "Email")?.toLowerCase();
    if (consoleEmail && consoleEmail.toLowerCase() !== "[email]" && consoleEmail !== email) { warnings.push(`${id}: email de console différent du titre de fenêtre`); continue; }
    const github = field(c, "GitHub"), vpn = field(c, "VPN production"), slack = field(c, "Slack");
    const ghLevel = mappings.github[github?.toLowerCase() as keyof typeof mappings.github];
    const vpnLevel = mappings["vpn-prod"][vpn?.toLowerCase() as keyof typeof mappings["vpn-prod"]];
    const slackLevel = mappings.slack[slack?.toLowerCase() as keyof typeof mappings.slack];
    const expiryRaw = field(c, "Expiration"), expiry = expiryRaw ? parseDate(expiryRaw) : undefined;
    if (!ghLevel || !vpnLevel || !slackLevel || (expiryRaw && !expiry && !/^(aucune|—|non)$/i.test(expiryRaw)) || (contract === "prestataire" && !expiry)) { warnings.push(`${id}: résumé enregistré incomplet ou expiration manquante/invalide`); continue; }
    const evidence: Evidence[] = [];
    for (const r of [ticket, consoleFrame]) {
      for (const label of labels.filter(l => l !== "de contrat" || (identity.fromConsole && !field(ticket.text, "Type de contrat")))) {
        const observed = observedField(r.text, label);
        if (observed) {
          // Keep comments bounded; slicing preserves exact source substrings.
          const quote = observed.quote.slice(0, label === "Commentaire" ? 240 : 500);
          if (!evidence.some(e => e.frame_id === r.frame_id && e.quote === quote)) evidence.push({ frame_id: r.frame_id, quote });
        }
      }
      const saved = r.text.match(/Modifications enregistrées[^\r\n]*?(?=GitHub[ \t]*:|\r|\n|$)/)?.[0].trim();
      if (saved) evidence.push({ frame_id: r.frame_id, quote: saved });
    }
    if (identity.fromConsole) {
      const linked = candidates.filter(r => ticketLink.test(r.text));
      const source = latest(linked);
      if (!source) { warnings.push(`${id}: lien de console introuvable`); continue; }
      // Quote only the relevant title prefix; omit browser/profile metadata.
      const emailEnd = source.window_name.toLowerCase().indexOf(email) + email.length;
      evidence.push({ frame_id: source.frame_id, quote: source.window_name.slice(0, emailEnd) });
      const link = source.text.match(ticketLink)!;
      evidence.push({ frame_id: source.frame_id, quote: link[0] });
    }
    const scenario: Scenario = { title: `${id} · ${name} · ${contract}`, origin: `${provenance === "synthetic-demo" ? "DÉMO FICTIVE" : "Screenpipe"} · Bob · ${id}`,
      ticket: { id, type: "access_request", requester: { name, email, contract, team, ...(end_date ? { end_date } : {}) } },
      expected: { github: ghLevel, "vpn-prod": vpnLevel, slack: slackLevel, ...(expiry ? { expires_before: expiry } : {}), ticket_status: "done" }, evidence };
    try { validateScenario(scenario); scenarios.push(scenario); }
    catch { warnings.push(`${id}: scénario extrait invalide, vérifier les champs observés`); }
  }
  return { scenarios, warnings };
}

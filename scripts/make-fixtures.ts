// Creates ONLY synthetic demo data. Never represents a Screenpipe recording.
import type { RecordingFixture, Scenario } from "../src/types.ts";
const row = (frame_id: number, timestamp: string, window_name: string, text: string) => ({ type: "Accessibility", content: { frame_id, timestamp, window_name, text, app_name: "Nimbus IT (synthetic)" } });
const tickets = [
  row(51100, "2026-10-18T07:00:00Z", "T-1175 · Tickets Nimbus", "Type : access_request\nDemandeur : Hugo Petit\nEmail : hugo.petit@nimbus.example\nType de contrat : CDI\nÉquipe : support\nStatut : Terminé\nCommentaire : Profil standard approuvé."),
  row(51190, "2026-10-18T07:20:00Z", "T-1182 · Tickets Nimbus", "Type : access_request\nDemandeur : Inès Fabre\nEmail : ines.fabre@presta.example\nType de contrat : Prestataire\nÉquipe : data\nFin de mission : 15/01/2027\nStatut : Terminé\nCommentaire : Mission de 3 mois en prestation : GitHub en lecture seule, pas de VPN prod"),
];
const consoles = [
  row(51102, "2026-10-18T07:05:00Z", "Console des permissions · hugo.petit@nimbus.example", "Email : hugo.petit@nimbus.example\nModifications enregistrées le 18/10/2026 à 09:05\nGitHub : Écriture\nVPN production : Oui\nSlack : Membre\nExpiration : Aucune"),
  row(51200, "2026-10-18T07:21:00Z", "Console des permissions · ines.fabre@presta.example", "Modifications enregistrées le 18/10/2026 à 09:21\nGitHub : Écriture\nVPN production : Oui\nSlack : Membre\nExpiration : Aucune"),
  row(51234, "2026-10-18T07:24:00Z", "Console des permissions · ines.fabre@presta.example", "Email : ines.fabre@presta.example\nModifications enregistrées le 18/10/2026 à 09:24\nGitHub : Lecture seule\nVPN production : Non\nSlack : Invité\nExpiration : 15/01/2027"),
  row(51235, "2026-10-18T07:25:00Z", "Console des permissions · ines.fabre@presta.example", "Modifications non enregistrées\nGitHub : Écriture\nVPN production : Oui\nSlack : Membre"),
];
const fixture: RecordingFixture = { format: "canary-screenpipe/v1", provenance: "synthetic-demo", captured_at: "2026-10-18T07:30:00Z", start_time: "2026-10-17T07:30:00Z", end_time: "2026-10-18T07:30:00Z", pages: [
  { window_name: "Tickets Nimbus", content_type: "accessibility", offset: 0, response: { data: tickets, pagination: { total: 2, limit: 20, offset: 0 } } },
  { window_name: "Tickets Nimbus", content_type: "accessibility", offset: 2, response: { data: [] } },
  { window_name: "Console des permissions", content_type: "accessibility", offset: 0, response: { data: consoles } },
  { window_name: "Console des permissions", content_type: "accessibility", offset: 4, response: { data: [] } },
] };
await Bun.write(new URL("../fixtures/bob.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
const alice: Scenario = { title: "CDI développement (Alice)", origin: "Manuel · Alice · DÉMO FICTIVE", ticket: { id: "T-ALICE", type: "access_request", requester: { name: "Alice Martin", email: "alice@nimbus.example", contract: "cdi", team: "développement" } }, expected: { github: "write", "vpn-prod": "access", slack: "member", ticket_status: "done" }, evidence: [] };
await Bun.write(new URL("../fixtures/alice.json", import.meta.url), JSON.stringify(alice, null, 2) + "\n");

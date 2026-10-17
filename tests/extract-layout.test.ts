import { expect, test } from "bun:test";
import { extractScenarios } from "../src/extract.ts";
import type { ScreenRecord } from "../src/types.ts";

// Entirely synthetic observations reproducing the compact/redacted Screenpipe layout.
const ticket: ScreenRecord = {
  frame_id: 201, timestamp: "2026-10-18T09:00:00Z", window_name: "T-9001 · Tickets Nimbus - Google Chrome – Demo profile",
  text: "Nimbus ITTicketsT-9001Type : access_requestStatut : OuvertDemandeur : Zoé ExempleEmail : [EMAIL] de contrat : PrestataireÉquipe : dataFin de mission : 15/01/2027ActionsOuvrir la console des permissionsCommentairesCommentaire : Mission de démonstration.AuteurDemo",
};
const consoleRecord: ScreenRecord = {
  frame_id: 202, timestamp: "2026-10-18T09:02:00Z", window_name: "Console des permissions · zoe@presta.example - Google Chrome – Demo profile",
  text: "Console des permissions[EMAIL] • Ticket T-9001AccèsGitHubLecture seuleVPN productionNonSlackInvitéExpiration15/01/2027Modifications enregistrées le 18/10/2026 à 11:02GitHub : Lecture seuleVPN production : NonSlack : InvitéExpiration: 15/01/2027Enregistrer",
};

test("compact labels and masked email join only through captured ticket link and console title", () => {
  const result = extractScenarios([ticket, consoleRecord]);
  expect(result.warnings).toEqual([]); expect(result.scenarios).toHaveLength(1);
  const scenario = result.scenarios[0];
  expect(scenario.ticket.requester).toEqual({ name: "Zoé Exemple", email: "zoe@presta.example", contract: "prestataire", team: "data", end_date: "2027-01-15" });
  expect(scenario.expected).toEqual({ github: "read", "vpn-prod": "none", slack: "guest", expires_before: "2027-01-15", ticket_status: "done" });
  expect(scenario.evidence).toContainEqual({ frame_id: 202, quote: "Console des permissions · zoe@presta.example" });
  expect(scenario.evidence).toContainEqual({ frame_id: 202, quote: "Ticket T-9001" });
  for (const e of scenario.evidence) expect([ticket, consoleRecord].some(r => r.frame_id === e.frame_id && (r.text.includes(e.quote) || r.window_name.includes(e.quote)))).toBe(true);
  expect(scenario.evidence.some(e => e.quote.includes("Demo profile"))).toBe(false);
});
test("compact unredacted fields and intact contract label also work", () => {
  const visible = { ...ticket, text: ticket.text.replace("[EMAIL] de contrat", "zoe@presta.exampleType de contrat") };
  expect(extractScenarios([visible, consoleRecord]).scenarios[0].ticket.requester.email).toBe("zoe@presta.example");
});
test("masked email without an explicit ticket link is never guessed", () => {
  const unlinked = { ...consoleRecord, text: consoleRecord.text.replace("Ticket T-9001", "Console") };
  const result = extractScenarios([ticket, unlinked]);
  expect(result.scenarios).toEqual([]); expect(result.warnings[0]).toContain("association ambiguë");
});
test("multiple console identities for one masked ticket are ambiguous", () => {
  const other = { ...consoleRecord, frame_id: 203, window_name: consoleRecord.window_name.replace("zoe@presta.example", "other@presta.example") };
  expect(extractScenarios([ticket, consoleRecord, other]).scenarios).toEqual([]);
});
test("test ticket suffix cannot be mistaken for original ticket identity", () => {
  const copied = { ...consoleRecord, text: consoleRecord.text.replace("Ticket T-9001", "Ticket T-9001-R7") };
  expect(extractScenarios([ticket, copied]).scenarios).toEqual([]);
});
test("unsaved console cannot establish the identity of a masked ticket", () => {
  const unsaved = { ...consoleRecord, text: consoleRecord.text.replace("Modifications enregistrées", "Modifications non enregistrées") };
  expect(extractScenarios([ticket, unsaved]).scenarios).toEqual([]);
});
test("newer saved console for another ticket invalidates a masked association", () => {
  const newer = { ...consoleRecord, frame_id: 203, timestamp: "2026-10-18T09:04:00Z", text: consoleRecord.text.replace("Ticket T-9001", "Ticket T-9002") };
  const result = extractScenarios([ticket, consoleRecord, newer]);
  expect(result.scenarios).toEqual([]); expect(result.warnings[0]).toContain("dernière console");
});
test("compact invalid date and blank label stay rejected", () => {
  expect(extractScenarios([{ ...ticket, text: ticket.text.replace("15/01/2027", "31/02/2027") }, consoleRecord]).scenarios).toEqual([]);
  expect(extractScenarios([{ ...ticket, text: ticket.text.replace("Équipe : data", "Équipe : ") }, consoleRecord]).scenarios).toEqual([]);
});

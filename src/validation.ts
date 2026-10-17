import { LEVELS, type ActionCall, type Scenario } from "./types.ts";

export function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function text(v: unknown): v is string { return typeof v === "string" && !!v.trim(); }
function fields(value: unknown, allowed: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`Invalid ${label} fields`);
}
export function validateScenario(value: unknown): asserts value is Scenario {
  fields(value, ["title", "origin", "ticket", "expected", "evidence"], "scenario");
  const s = value as Scenario;
  if (!s || !text(s.title) || !text(s.origin) || s.ticket?.type !== "access_request") throw new Error("Invalid scenario header/ticket");
  const p = s.ticket.requester;
  fields(s.ticket, ["id", "type", "requester"], "ticket");
  if (s.ticket.id !== undefined && !text(s.ticket.id)) throw new Error("Invalid ticket id");
  fields(p, ["name", "email", "contract", "team", "end_date"], "requester");
  if (!p || !text(p.name) || !text(p.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) || !text(p.team) || !["cdi", "prestataire"].includes(p.contract)) throw new Error("Invalid requester");
  if (p.end_date !== undefined && !isDate(p.end_date)) throw new Error("Invalid end_date");
  if (!s.expected || !text(s.expected.ticket_status)) throw new Error("Invalid expectations");
  fields(s.expected, ["github", "vpn-prod", "slack", "expires_before", "ticket_status"], "expected");
  for (const system of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
    if (!(LEVELS[system] as readonly unknown[]).includes(s.expected[system])) throw new Error(`Invalid expected ${system}`);
  }
  if (s.expected.expires_before !== undefined && !isDate(s.expected.expires_before)) throw new Error("Invalid expires_before");
  if (!Array.isArray(s.evidence) || s.evidence.some(e => !e || !Number.isSafeInteger(e.frame_id) || e.frame_id < 0 || !text(e.quote))) throw new Error("Invalid evidence");
  for (const e of s.evidence) fields(e, ["frame_id", "quote"], "evidence");
}
export const ACTION_FIELDS = {
  "iam.grant": { required: ["user", "system", "level"], optional: ["expires"] },
  "tickets.comment": { required: ["id", "text"], optional: [] },
  "tickets.close": { required: ["id"], optional: [] },
} as const;
export function validateAction(action: string, args: Record<string, unknown>): asserts action is ActionCall["action"] {
  if (!Object.hasOwn(ACTION_FIELDS, action)) throw new Error(`Unknown action: ${action}`);
  const fields = ACTION_FIELDS[action as keyof typeof ACTION_FIELDS];
  const allowed: readonly string[] = [...fields.required, ...fields.optional];
  if (fields.required.some(k => !Object.hasOwn(args, k)) || Object.keys(args).some(k => !allowed.includes(k))) throw new Error(`Invalid arguments for ${action}`);
}
export function validateCall(action: string, args: Record<string, unknown>): ActionCall {
  validateAction(action, args);
  if (Object.values(args).some(v => !text(v))) throw new Error("Action arguments must be non-empty strings");
  if (action === "iam.grant") {
    if (!Object.hasOwn(LEVELS, String(args.system)) || !(LEVELS[args.system as keyof typeof LEVELS] as readonly unknown[]).includes(args.level)) throw new Error("Invalid system/level combination");
    if (args.expires !== undefined && !isDate(args.expires)) throw new Error("Invalid expiration date");
  }
  return { action, args } as ActionCall;
}

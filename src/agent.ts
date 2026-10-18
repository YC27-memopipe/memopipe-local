import { hubOrigin } from "./hub.ts";
import type { BrowserId, ScreenpipeClient } from "./screenpipe.ts";

/** Real actions queued by the hub (which cannot reach Screenpipe) and executed on this PC. */
export interface AgentJob { id: number; action: string; args: Record<string, unknown>; }
export interface Mail { id: number; from: string; to: string; subject: string; date: string; snippet?: string; }
export interface MailSearch { count: number; first: Mail | null; items: Mail[]; }
export interface MailSent { to: string; delivered_to: string; redirected: boolean; }
export type Handler = (args: Record<string, unknown>) => Promise<unknown>;
export interface SendOptions { browser: BrowserId; testInbox?: string; sleep?: (ms: number) => Promise<void>; composeTimeoutMs?: number; confirmTimeoutMs?: number; }
export interface HubLink { base: string; token: string; label: string; fetcher?: typeof fetch; }
export class AgentAuthError extends Error {}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const text = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
};

/** gmail.search: Gmail inbox through Screenpipe's IMAP connection, newest first; snippet of the newest. */
export async function gmailSearch(client: ScreenpipeClient, args: Record<string, unknown>): Promise<MailSearch> {
  const query = text(args.query, "gmail.search query");
  const limit = args.limit == null || args.limit === "" ? 5 : Number(args.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("gmail.search limit must be between 1 and 20");
  const items: Mail[] = (await client.imapMessages(query, limit)).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  if (!items[0]) return { count: 0, first: null, items };
  const full = await client.imapMessage(items[0].id);
  const snippet = (full.snippet || full.body).replace(/\s+/g, " ").trim().slice(0, 600);
  return { count: items.length, first: { ...items[0], snippet }, items };
}

/** Ref (eNN) of Gmail's "Envoyer" / "Send" button in a Screenpipe browser snapshot. */
export function findSendButton(tree: string): string | null {
  for (const line of tree.split("\n")) {
    if (!/button/i.test(line)) continue;
    const ref = /#(e\d+)\b/.exec(line)?.[1] ?? /\bref[=:]\s*"?(e\d+)/.exec(line)?.[1];
    if (!ref) continue;
    const name = line.replace(/\[[^\]]*\]/g, " ").replace(/#e\d+\b|\bref[=:]\s*"?e\d+"?/g, " ").replace(/[‪-‮"]/g, "").replace(/^[\s\-–•]*(button)?\s*/i, "").trim();
    const first = name.split(/[\s(]+/)[0] ?? "";
    if (/^(envoyer|send)$/i.test(first) && !/plus tard|later|options|planifier|schedule/i.test(name)) return ref;
  }
  return null;
}

/** gmail.send: prefilled Gmail compose in the Screenpipe browser, then one click on Send. */
export async function gmailSend(client: ScreenpipeClient, args: Record<string, unknown>, options: SendOptions): Promise<MailSent> {
  const to = text(args.to, "gmail.send to"), subject = text(args.subject, "gmail.send subject"), body = text(args.body, "gmail.send body");
  if (!EMAIL.test(to)) throw new Error("gmail.send to must be an email address");
  const inbox = options.testInbox?.trim() ?? "";
  if (inbox && !EMAIL.test(inbox)) throw new Error("Test inbox must be an email address");
  const deliveredTo = inbox || to, redirected = !!inbox && inbox.toLowerCase() !== to.toLowerCase();
  const su = redirected ? `[memopipe · test pour ${to}] ${subject}` : subject;
  const query = Object.entries({ view: "cm", fs: "1", tf: "1", to: deliveredTo, su, body }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  await client.browserNavigate(options.browser, `https://mail.google.com/mail/?${query}`);
  const sleep = options.sleep ?? wait;
  let ref: string | null = null;
  for (const deadline = Date.now() + (options.composeTimeoutMs ?? 30000); ;) {
    const snapshot = await client.browserSnapshot(options.browser);
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(`${snapshot.url} ${snapshot.title}`)) throw new Error(`Gmail is not signed in inside Screenpipe's ${options.browser} browser: open mail.google.com there once and sign in`);
    ref = findSendButton(snapshot.tree);
    if (ref) break;
    if (Date.now() >= deadline) throw new Error("Gmail Send button not found before timeout");
    await sleep(1000);
  }
  await client.browserClick(options.browser, ref);
  for (const deadline = Date.now() + (options.confirmTimeoutMs ?? 20000); ;) {
    await sleep(1000);
    const tree = (await client.browserSnapshot(options.browser)).tree;
    // The compose window closes (no Send button left) once Gmail accepted the message.
    if (/Message envoyé|Message sent/i.test(tree) || !findSendButton(tree)) return { to, delivered_to: deliveredTo, redirected };
    if (Date.now() >= deadline) throw new Error("Gmail did not confirm the send before timeout");
  }
}

export function createHandlers(client: ScreenpipeClient, options: SendOptions): Record<string, Handler> {
  return { "gmail.search": args => gmailSearch(client, args), "gmail.send": args => gmailSend(client, args, options) };
}

function hubHeaders(link: HubLink) {
  if (!link.token.trim()) throw new Error("Hub token required (CANARY_TEAM_TOKEN)");
  return { Authorization: `Bearer ${link.token}`, "Content-Type": "application/json", "X-Memopipe-Agent": link.label.slice(0, 80) };
}
async function hubFetch(link: HubLink, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = hubHeaders(link), url = new URL(path, hubOrigin(link.base));
  let response: Response;
  try {
    response = await (link.fetcher ?? fetch)(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(75000) });
  } catch { throw new Error("Hub unreachable, redirect refused or request timed out"); }
  if (response.status === 401) throw new AgentAuthError("Hub rejected the team token (HTTP 401): use the hub's MEMOPIPE_TEAM_TOKEN as CANARY_TEAM_TOKEN");
  return response;
}

/** Claims the oldest pending real action on the hub, or null when the queue is empty. */
export async function nextJob(link: HubLink): Promise<AgentJob | null> {
  const response = await hubFetch(link, "/api/agent/next");
  if (!response.ok) throw new Error(`Hub HTTP ${response.status} on /api/agent/next`);
  const body = await response.json().catch(() => undefined) as { job?: unknown } | undefined;
  if (body?.job === null) return null;
  const job = body?.job as AgentJob | undefined;
  if (!job || !Number.isSafeInteger(job.id) || typeof job.action !== "string" || !job.args || typeof job.args !== "object" || Array.isArray(job.args)) throw new Error("Invalid hub job: expected {id, action, args}");
  return job;
}

export async function reportJob(link: HubLink, id: number, outcome: { ok: true; result: unknown } | { ok: false; error: string }): Promise<void> {
  const response = await hubFetch(link, `/api/agent/jobs/${id}`, { method: "POST", body: JSON.stringify(outcome) });
  if (!response.ok) throw new Error(`Hub HTTP ${response.status}; result of job ${id} not recorded`);
}

/** One cycle: claim, execute locally, report. The action runs at most once; a failed report is not retried. */
export async function processOnce(link: HubLink, handlers: Record<string, Handler>): Promise<{ job: AgentJob; ok: boolean; error?: string; ms: number } | null> {
  const job = await nextJob(link);
  if (!job) return null;
  const started = Date.now();
  const handler = Object.prototype.hasOwnProperty.call(handlers, job.action) ? handlers[job.action] : undefined;
  if (!handler) {
    const error = `Unknown action for this agent: ${job.action}`;
    await reportJob(link, job.id, { ok: false, error });
    return { job, ok: false, error, ms: 0 };
  }
  let outcome: { ok: true; result: unknown } | { ok: false; error: string };
  try {
    outcome = { ok: true, result: await handler(job.args) };
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await reportJob(link, job.id, outcome);
  return { job, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), ms: Date.now() - started };
}

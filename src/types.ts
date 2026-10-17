export const LEVELS = {
  github: ["none", "read", "write"],
  "vpn-prod": ["none", "access"],
  slack: ["none", "guest", "member"],
} as const;
export type System = keyof typeof LEVELS;
export type Level = typeof LEVELS[System][number];
export interface Requester {
  name: string; email: string; contract: "cdi" | "prestataire"; team: string; end_date?: string;
}
export interface TicketInput { id?: string; type: "access_request"; requester: Requester; }
export interface Ticket extends TicketInput { id: string; status: string; comments: string[]; }
export interface Evidence { frame_id: number; quote: string; }
export interface Expected {
  github: "none" | "read" | "write";
  "vpn-prod": "none" | "access";
  slack: "none" | "guest" | "member";
  expires_before?: string; ticket_status: string;
}
export interface Scenario {
  title: string; origin: string; ticket: TicketInput; expected: Expected; evidence: Evidence[];
}
export interface Grant { email: string; system: System; level: Level; expires?: string; }
export interface Snapshot { ticket: Ticket; grants: Grant[]; }
export type ActionCall =
  | { action: "iam.grant"; args: { user: string; system: System; level: Level; expires?: string } }
  | { action: "tickets.comment"; args: { id: string; text: string } }
  | { action: "tickets.close"; args: { id: string } };
/** Adapter operations must be scoped to runId. execute must deduplicate operationId. */
export interface ActionAdapter {
  createTestTicket(input: TicketInput, runId: string): Promise<Ticket>;
  execute(call: ActionCall, context: { runId: string; operationId: string }): Promise<unknown>;
  snapshot(ticket: Ticket, runId: string): Promise<Snapshot>;
}
export type Value = string | boolean | null | { [key: string]: Value };
export type Expr =
  | { kind: "literal"; value: string }
  | { kind: "path"; path: string[] }
  | { kind: "not"; value: Expr }
  | { kind: "binary"; op: "==" | "!=" | "and" | "or"; left: Expr; right: Expr };
export type Instruction = { line: number; source: string } & (
  | { op: "set"; name: string; value: Expr }
  | { op: "do"; action: ActionCall["action"]; args: Record<string, Expr> }
  | { op: "branch"; condition: Expr; target: number }
  | { op: "jump"; target: number }
);
export interface Program { format: "canary-dsl/v1"; title?: string; usage?: string; instructions: Instruction[]; }
export interface StepLog {
  pc: number; line: number; source: string; nextPc: number;
  status: "ok" | "error"; result?: unknown; error?: string;
}
export interface RunState {
  id: string; program: Program; scenario: Scenario; ticket: Ticket;
  pc: number; vars: Record<string, Value>; steps: StepLog[];
  status: "running" | "completed" | "failed";
}
export interface Difference { field: System | "expiration" | "ticket_status"; expected: unknown; actual: unknown; reason: string; }
export interface Comparison { passed: boolean; differences: Difference[]; actual: Snapshot; }
/** One validated scenario per POST /api/scenarios. No raw capture payload. */
export interface ScenarioUploadRequest { automation_id: string; author: "Bob"; scenario: Scenario; }
export interface ScenarioUploadResponse { id: string; }
export interface ScreenRecord { frame_id: number; timestamp: string; window_name: string; text: string; }
export interface RecordingFixture {
  format: "canary-screenpipe/v1"; provenance: "synthetic-demo" | "recorded";
  captured_at: string; start_time: string; end_time: string;
  pages: { window_name: string; content_type: "accessibility" | "ocr"; offset: number; response: unknown }[];
}

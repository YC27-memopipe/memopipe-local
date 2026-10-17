import type { ActionAdapter, ActionCall, Grant, Snapshot, Ticket, TicketInput } from "./types.ts";
import { validateCall } from "./validation.ts";

export class MemoryAdapter implements ActionAdapter {
  private runs = new Map<string, Snapshot>();
  private receipts = new Map<string, { signature: string; result: unknown }>();
  async createTestTicket(input: TicketInput, runId: string): Promise<Ticket> {
    if (this.runs.has(runId)) throw new Error("Duplicate runId");
    const copy = structuredClone(input);
    const [local, domain] = copy.requester.email.split("@");
    const ticket: Ticket = { ...copy, id: `${input.id ?? "T-TEST"}-R${runId}`, status: "approved", comments: [],
      requester: { ...copy.requester, email: `${local}+r${runId}@${domain}` } };
    this.runs.set(runId, { ticket, grants: [] }); return structuredClone(ticket);
  }
  async execute(call: ActionCall, context: { runId: string; operationId: string }): Promise<unknown> {
    validateCall(call.action, call.args);
    const snapshot = this.runs.get(context.runId); if (!snapshot) throw new Error("Unknown run");
    const key = `${context.runId}/${context.operationId}`; const signature = JSON.stringify(call);
    const receipt = this.receipts.get(key);
    if (receipt) { if (receipt.signature !== signature) throw new Error("Conflicting operationId"); return structuredClone(receipt.result); }
    const { ticket, grants } = snapshot;
    if (call.action === "iam.grant") {
      if (call.args.user !== ticket.requester.email) throw new Error("Wrong test user");
      const grant: Grant = { email: call.args.user, system: call.args.system, level: call.args.level, ...(call.args.expires ? { expires: call.args.expires } : {}) };
      const index = grants.findIndex(g => g.system === grant.system);
      if (index < 0) grants.push(grant); else grants[index] = grant;
    } else {
      if (call.args.id !== ticket.id) throw new Error("Wrong test ticket");
      if (call.action === "tickets.comment") ticket.comments.push(call.args.text);
      else ticket.status = "done";
    }
    const result = structuredClone(snapshot);
    this.receipts.set(key, { signature, result }); return result;
  }
  async snapshot(ticket: Ticket, runId: string): Promise<Snapshot> {
    const snapshot = this.runs.get(runId);
    if (!snapshot || snapshot.ticket.id !== ticket.id) throw new Error("Unknown test ticket"); return structuredClone(snapshot);
  }
}

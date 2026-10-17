import type { ActionAdapter, Comparison, Program, RunState, Scenario, Snapshot, Value } from "./types.ts";
import { LEVELS } from "./types.ts";
import { isDate, validateCall, validateScenario } from "./validation.ts";
import { compile, evaluate } from "./dsl.ts";

export async function start(program: Program, scenario: Scenario, adapter: ActionAdapter, runId: string = crypto.randomUUID()): Promise<RunState> {
  validateScenario(scenario);
  const ticket = await adapter.createTestTicket(structuredClone(scenario.ticket), runId);
  if (ticket.id === scenario.ticket.id || ticket.requester.email === scenario.ticket.requester.email) throw new Error("Adapter must create an isolated ticket AND email");
  return { id: runId, program: structuredClone(program), scenario: structuredClone(scenario), ticket, pc: 0,
    vars: { ticket: structuredClone(ticket) as unknown as Value }, steps: [], status: "running" };
}
/** Immutable transition; persist returned state after every call. Serialize calls per run. */
export async function step(state: RunState, adapter: ActionAdapter): Promise<RunState> {
  if (state.status !== "running") return state;
  const next = structuredClone(state); const instruction = next.program.instructions[next.pc];
  if (!instruction) throw new Error("Invalid program counter");
  const pc = next.pc; let result: unknown;
  try {
    next.pc++;
    switch (instruction.op) {
      case "set": result = evaluate(instruction.value, next.vars); next.vars[instruction.name] = structuredClone(result as Value); break;
      case "branch": result = !!evaluate(instruction.condition, next.vars); if (!result) next.pc = instruction.target; break;
      case "jump": next.pc = instruction.target; result = { target: next.pc }; break;
      case "do": {
        const args = Object.fromEntries(Object.entries(instruction.args).map(([k, e]) => [k, evaluate(e, next.vars)]));
        const call = validateCall(instruction.action, args);
        if (call.action === "iam.grant" ? call.args.user !== next.ticket.requester.email : call.args.id !== next.ticket.id) throw new Error("Action targets a resource outside this test run");
        result = await adapter.execute(call, { runId: next.id, operationId: `${next.id}:${pc}` });
        break;
      }
    }
    next.steps.push({ pc, line: instruction.line, source: instruction.source, nextPc: next.pc, status: "ok", result });
    if (next.pc === next.program.instructions.length) next.status = "completed";
  } catch (error) {
    next.pc = pc; next.status = "failed";
    next.steps.push({ pc, line: instruction.line, source: instruction.source, nextPc: pc, status: "error", error: (error as Error).message });
  }
  return next;
}
export function compare(scenario: Scenario, actual: Snapshot): Comparison {
  validateScenario(scenario);
  const differences: Comparison["differences"] = [];
  const grants = actual.grants.filter(g => g.email === actual.ticket.requester.email);
  for (const system of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
    const entries = grants.filter(g => g.system === system && g.level !== "none");
    const level = entries.length === 0 ? "none" : entries.length === 1 ? entries[0].level : entries.map(g => g.level);
    if (level !== scenario.expected[system]) differences.push({ field: system, expected: scenario.expected[system], actual: level, reason: "Access differs (including excessive permissions)" });
  }
  if (scenario.expected.expires_before) {
    const invalid = grants.filter(g => g.level !== "none" && (!isDate(g.expires) || g.expires > scenario.expected.expires_before!));
    // Aggregate expiration failures into one difference, as in the MVP's four-gap example.
    if (invalid.length) differences.push({ field: "expiration", expected: scenario.expected.expires_before, actual: invalid, reason: "Missing, invalid or late expiration" });
  }
  if (actual.ticket.status !== scenario.expected.ticket_status) differences.push({ field: "ticket_status", expected: scenario.expected.ticket_status, actual: actual.ticket.status, reason: "Unexpected final ticket status" });
  return { passed: differences.length === 0, differences, actual };
}
export async function finish(state: RunState, adapter: ActionAdapter): Promise<{ state: RunState; comparison: Comparison }> {
  let current = state;
  for (let n = 0; current.status === "running"; n++) {
    if (n > current.program.instructions.length) throw new Error("Step limit exceeded");
    current = await step(current, adapter);
  }
  const comparison = compare(current.scenario, await adapter.snapshot(current.ticket, current.id));
  if (current.status === "failed") comparison.passed = false;
  return { state: current, comparison };
}
export async function testAll(source: string | Program, scenarios: Scenario[], adapter: ActionAdapter) {
  const program = typeof source === "string" ? compile(source) : source;
  scenarios.forEach(validateScenario);
  const results = [];
  for (const scenario of scenarios) results.push(await finish(await start(program, scenario, adapter), adapter));
  return results;
}

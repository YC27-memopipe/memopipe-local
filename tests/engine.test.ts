import { describe, expect, test } from "bun:test";
import { compile, evaluate, start, step, finish, compare, testAll, MemoryAdapter, type Scenario, type RecordingFixture } from "../src/index.ts";
import { fixtureRecords } from "../src/screenpipe.ts";
import { extractScenarios } from "../src/extract.ts";
const root = new URL("../", import.meta.url);
const alice: Scenario = await Bun.file(new URL("fixtures/alice.json", root)).json();
const bob: RecordingFixture = await Bun.file(new URL("fixtures/bob.json", root)).json();
const scenarios = [alice, ...extractScenarios(fixtureRecords(bob), bob.provenance).scenarios];
const v1 = await Bun.file(new URL("examples/v1.canary", root)).text();
const v2 = await Bun.file(new URL("examples/v2.canary", root)).text();

describe("DSL validation and compilation", () => {
  test.each([
    'DO system.exec command="oops"', 'IF ticket.type == "access_request"\nSET p = ticket.requester',
    'ELSE', 'END', 'IF "x"\nELSE\nELSE\nEND', 'SET ticket = "x"',
    'SET __proto__ = "x"', 'SET p = ticket.constructor',
    'DO tickets.close', 'DO tickets.close id=ticket.id extra="x"',
    'DO tickets.close id=ticket.id id="x"', 'BOGUS "x"',
    'SET p = "unterminated', 'SET p = ticket.requester + "x"',
    'DO iam.grant user=ticket.requester.email system="github" level="owner"',
    'DO tickets.comment id=ticket.id text="{{ticket.__proto__}}"',
    'SET p = "{{bad interpolation}}"', 'SET p = ticket.requester.email()'
    , '"SET" p = "x"', 'DO "tickets.close" id=ticket.id',
    'DO iam.grant user=ticket.requester.email system="unknown" level=p.level',
    'DO iam.grant user=ticket.requester.email system="github" level=p.level expires="31/02/2027"'
  ])("rejects invalid DSL: %s", source => expect(() => compile(source)).toThrow());
  test("IF and ELSE jump targets", () => {
    const p = compile('IF ticket.type == "access_request"\nSET a = "yes"\nELSE\nSET a = "no"\nEND\nSET b = "end"');
    expect(p.instructions.map(i => i.op)).toEqual(["branch", "set", "jump", "set", "set"]);
    expect(p.instructions[0]).toMatchObject({ target: 3 });
    expect(p.instructions[2]).toMatchObject({ target: 4 });
  });
  test("precedence, parentheses, inequality, not and short circuit", () => {
    for (const expression of ['not p == "no" and p != "x" or missing', '(p == "yes" or missing) and not p == "no"']) {
      const instruction = compile(`IF ${expression}\nSET a = "yes"\nEND`).instructions[0];
      if (instruction.op !== "branch") throw new Error();
      expect(evaluate(instruction.condition, { p: "yes" })).toBe(true);
    }
  });
  test("undefined variables fail without prototype traversal", () => {
    const i = compile("SET p = ticket.missing").instructions[0];
    if (i.op === "set") expect(() => evaluate(i.value, { ticket: {} })).toThrow("Unknown variable");
  });
});

describe("runner", () => {
  test("v1 contractor has exactly four differences", async () => {
    const result = await testAll(v1, [scenarios[2]], new MemoryAdapter());
    expect(result[0].comparison.differences.map(d => d.field)).toEqual(["github", "vpn-prod", "slack", "expiration"]);
    expect(result[0].state.status).toBe("completed");
  });
  test("corrected version passes all three scenarios", async () => {
    const result = await testAll(v2, scenarios, new MemoryAdapter());
    expect(result.map(r => r.comparison.differences.length)).toEqual([0, 0, 0]);
    expect(result.every(r => r.comparison.passed)).toBe(true);
    expect(result[2].comparison.actual.ticket.comments).toEqual(["Accès attribués (prestataire)."]);
  });
  test("one step, JSON persistence, idempotent replay and isolation", async () => {
    const adapter = new MemoryAdapter();
    const a = await start(compile(v1), alice, adapter, "1");
    const b = await start(compile(v1), alice, adapter, "2");
    expect(a.ticket.id).not.toBe(b.ticket.id); expect(a.ticket.requester.email).not.toBe(b.ticket.requester.email);
    const first = await step(a, adapter);
    expect(a.pc).toBe(0); expect(first.pc).toBe(1); expect(first.steps).toHaveLength(1);
    const r = await finish(JSON.parse(JSON.stringify(first)), adapter);
    const replay = await finish(first, adapter);
    expect(r.comparison.actual.ticket.comments).toHaveLength(1);
    expect(replay.comparison.actual.ticket.comments).toHaveLength(1);
    expect((await adapter.snapshot(b.ticket, b.id)).grants).toHaveLength(0);
    expect(await step(r.state, adapter)).toEqual(r.state);
  });
  test("nested branches execute correctly", async () => {
    const source = 'IF ticket.requester.contract == "cdi"\nIF ticket.requester.team == "développement"\nSET x = "inner"\nELSE\nSET x = "wrong"\nEND\nELSE\nSET x = "wrong"\nEND';
    const adapter = new MemoryAdapter(); const r = await finish(await start(compile(source), alice, adapter), adapter);
    expect(r.state.vars.x).toBe("inner");
  });
  test("failure is logged, halts execution and cannot pass", async () => {
    const adapter = new MemoryAdapter();
    const r = await finish(await start(compile('DO tickets.close id="another-ticket"'), alice, adapter), adapter);
    expect(r.state.status).toBe("failed"); expect(r.state.steps[0].status).toBe("error"); expect(r.comparison.passed).toBe(false);
  });
  test("adapter error and dynamic invalid argument produce failed step", async () => {
    const adapter = new MemoryAdapter();
    const r = await finish(await start(compile('SET level = "owner"\nDO iam.grant user=ticket.requester.email system="github" level=level'), alice, adapter), adapter);
    expect(r.state.status).toBe("failed"); expect(r.comparison.actual.grants).toEqual([]);
    const broken = new MemoryAdapter(); broken.execute = async () => { throw new Error("database offline"); };
    const s = await step(await start(compile('DO tickets.close id=ticket.id'), alice, broken), broken);
    expect(s.steps[0].error).toBe("database offline");
  });
  test("expiration missing/late aggregated; inclusive date; none is not a grant", async () => {
    const adapter = new MemoryAdapter(); const r = (await testAll(v2, [scenarios[2]], adapter))[0];
    const snapshot = structuredClone(r.comparison.actual);
    expect(compare(scenarios[2], snapshot).passed).toBe(true);
    snapshot.grants[0].expires = "2027-01-16"; delete snapshot.grants[1].expires;
    expect(compare(scenarios[2], snapshot).differences.map(d => d.field)).toEqual(["expiration"]);
    snapshot.ticket.status = "approved";
    expect(compare(scenarios[2], snapshot).differences.map(d => d.field)).toContain("ticket_status");
  });
});

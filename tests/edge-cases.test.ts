import { expect, test } from "bun:test";
import { compile, testAll, MemoryAdapter, validateScenario, type Scenario, type RecordingFixture } from "../src/index.ts";
import { ScreenpipeClient, normalizeRecords, fixtureRecords } from "../src/screenpipe.ts";
import { extractScenarios } from "../src/extract.ts";
import { uploadScenario } from "../src/hub.ts";
const alice: Scenario = await Bun.file(new URL("../fixtures/alice.json", import.meta.url)).json();
const fixture: RecordingFixture = await Bun.file(new URL("../fixtures/bob.json", import.meta.url)).json();
const start = fixture.start_time, end = fixture.end_time;
const fake = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;

test.each([null, {}, [], { data: null }, { data: {} }].map(value => [value]))("malformed Screenpipe envelope fails explicitly: %j", body => {
  expect(() => normalizeRecords(body)).toThrow("data[]");
});
test("incomplete individual observations are ignored without crashing", () => {
  expect(normalizeRecords({ data: [null, {}, { content: null }, { content: { frame_id: 1, text: "partial" } }] })).toEqual([]);
});
test.each([null, [], {}, { frame_status: null }].map(value => [value]))("invalid health does not claim active capture: %j", async body => {
  const c = new ScreenpipeClient({ fetcher: fake(body) });
  await expect(c.health()).rejects.toThrow("Invalid Screenpipe health");
});
test("invalid JSON, malformed search data and page limit are actionable errors", async () => {
  const badJson = new ScreenpipeClient({ fetcher: (async () => new Response("not json")) as unknown as typeof fetch });
  await expect(badJson.health()).rejects.toThrow("invalid JSON");
  await expect(new ScreenpipeClient({ key: "x", fetcher: fake({ results: [] }) }).history(start, end)).rejects.toThrow("data[]");
  const row = { content: fixtureRecords(fixture)[0] };
  await expect(new ScreenpipeClient({ key: "x", maxPages: 1, fetcher: fake({ data: [row] }) }).history(start, end)).rejects.toThrow("Pagination limit");
});
test("missing key stops authenticated search before network request", async () => {
  let called = false;
  const client = new ScreenpipeClient({ key: "", fetcher: (async () => { called = true; return Response.json({ data: [] }); }) as unknown as typeof fetch });
  await expect(client.history(start, end)).rejects.toThrow("SCREENPIPE_LOCAL_API_KEY"); expect(called).toBe(false);
});
test.each(["captured_at", "start_time", "end_time"] as const)("invalid fixture %s rejected", key => {
  const f = structuredClone(fixture); f[key] = "invalid";
  expect(() => fixtureRecords(f)).toThrow();
});
test.each([null, { offset: -1 }, { window_name: "Tickets Nimbus", content_type: "audio", offset: 0, response: { data: [] } }])("invalid fixture page rejected: %j", page => {
  expect(() => fixtureRecords({ ...fixture, pages: [page] } as any)).toThrow("Invalid fixture page");
});
test("duplicate frames/pages yield one scenario and one copy of each proof", () => {
  const f = structuredClone(fixture); f.pages.push(...structuredClone(fixture.pages));
  const unique = fixtureRecords(f);
  expect(unique).toHaveLength(fixtureRecords(fixture).length);
  expect(extractScenarios(unique).scenarios).toHaveLength(2);
});
test("blank label cannot consume the next line; invalid case does not hide a valid case", () => {
  const records = fixtureRecords(fixture).map(r => ({ ...r, text: r.text.replace("Équipe : support", "Équipe :\n") }));
  const result = extractScenarios(records);
  expect(result.scenarios).toHaveLength(1); expect(result.scenarios[0].ticket.id).toBe("T-1182");
  const badEmail = fixtureRecords(fixture).map(r => ({ ...r, text: r.text.replace("Email : hugo.petit@nimbus.example", "Email : not-an-email") }));
  expect(extractScenarios(badEmail).scenarios).toHaveLength(1);
});
test("inconsistent console identity and unsaved summaries cannot create a scenario", () => {
  const records = fixtureRecords(fixture).map(r => ({ ...r, text: r.window_name.includes("hugo") ? r.text.replace("Email : hugo.petit@nimbus.example", "Email : someone@example.org") : r.text }));
  expect(extractScenarios(records).scenarios).toHaveLength(1);
});
const invalidMutations: [string, (s: any) => void][] = [
  ["title", s => s.title = ""], ["requester", s => s.ticket.requester = null],
  ["email", s => s.ticket.requester.email = 12], ["contract", s => s.ticket.requester.contract = "unknown"],
  ["date", s => s.ticket.requester.end_date = "2027-02-30"], ["ticket id", s => s.ticket.id = {}],
  ["level", s => s.expected.github = "owner"], ["expiry", s => s.expected.expires_before = "15/01/2027"],
  ["null evidence", s => s.evidence = [null]], ["frame", s => s.evidence = [{ frame_id: -1, quote: "x" }]],
  ["extra captured payload", s => s.raw_capture = "must never be uploaded"],
];
test.each(invalidMutations)("invalid scenario %s rejected before network/action", async (_label, mutate) => {
  const s = structuredClone(alice); mutate(s);
  expect(() => validateScenario(s)).toThrow();
  let touched = false;
  await expect(uploadScenario("http://127.0.0.1:1", "x", { author: "Bob", automation_id: "a", scenario: s }, (async () => { touched = true; return Response.json({ id: "bad" }); }) as unknown as typeof fetch)).rejects.toThrow();
  const adapter = new MemoryAdapter(); adapter.createTestTicket = async () => { touched = true; throw new Error("unexpected mutation"); };
  await expect(testAll('SET p = ticket.requester', [alice, s], adapter)).rejects.toThrow(); expect(touched).toBe(false);
});
test.each(['SET p "=" "x"', 'DO tickets.close id "=" ticket.id'])("quoted assignment sign rejected: %s", source => expect(() => compile(source)).toThrow());
test("real Screenpipe 0.4.52 UI shape uses content.id as frame identity, never audio/input id", () => {
  const content = { id: 101, timestamp: "2026-10-18T09:00:00Z", window_name: "Synthetic demo window", text: "Synthetic regression text for the real observed response shape" };
  expect(normalizeRecords({ data: [{ type: "UI", content }] })).toEqual([{ frame_id: 101, timestamp: content.timestamp, window_name: content.window_name, text: content.text }]);
  expect(normalizeRecords({ data: [{ type: "Audio", content }, { type: "Input", content }] })).toEqual([]);
});

import { expect, test } from "bun:test";
import { discoverHistory, uploadDiscovery, type HistoryScope } from "../src/discovery.ts";
import { ScreenpipeClient, fixtureRecords } from "../src/screenpipe.ts";
import { createHandlers } from "../src/agent.ts";
import type { RecordingFixture } from "../src/types.ts";

const fixture: RecordingFixture = await Bun.file(new URL("../fixtures/bob.json", import.meta.url)).json();
const scope: HistoryScope = { consent: true, author: "Bob", start: fixture.start_time, end: fixture.end_time };

test("extract independently of any automation; keep synthetic provenance, author and exact evidence", async () => {
  const report = await discoverHistory(new ScreenpipeClient(), { ...scope, author: "Alice" }, fixture);
  expect(report.cases).toHaveLength(2);
  expect(report.provenance).toBe("synthetic-demo");
  expect(report.cases.every(c => c.origin.includes("Alice"))).toBe(true);
  const records = fixtureRecords(fixture);
  for (const c of report.cases) for (const e of c.evidence) expect(records.some(r => r.frame_id === e.frame_id && (r.text.includes(e.quote) || r.window_name.includes(e.quote)))).toBe(true);
});

test("agent requires explicit consent before any history request and uses fixed scope", async () => {
  const calls: URL[] = [];
  const client = new ScreenpipeClient({ key: "synthetic", fetcher: (async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname === "/health") return Response.json({ frame_status: "ok" });
    expect(url.searchParams.get("start_time")).toBe(scope.start);
    expect(url.searchParams.get("end_time")).toBe(scope.end);
    const records = fixtureRecords(fixture).filter(r => r.window_name.includes(url.searchParams.get("window_name")!));
    return Response.json({ data: url.searchParams.get("offset") === "0" ? records.map(content => ({ type: "OCR", content })) : [] });
  }) as typeof fetch });
  const handler = createHandlers(client, { browser: "owned-default" })["screenpipe.discover"];
  await expect(handler({ ...scope, consent: false })).rejects.toThrow("consent");
  expect(calls).toHaveLength(0);
  const report = await handler(scope as unknown as Record<string, unknown>) as Awaited<ReturnType<typeof discoverHistory>>;
  expect(report.provenance).toBe("recorded");
  expect(report.cases).toHaveLength(2);
  expect(calls[0].pathname).toBe("/health");
});

test("discovery upload sends only selected fields, uses team token, validates receipt and surfaces failures", async () => {
  const report = await discoverHistory(new ScreenpipeClient(), scope, fixture);
  const fetcher = (async (url, init) => {
    expect(String(url)).toBe("https://hub.example/api/discoveries");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer team");
    const payload = JSON.parse(String(init?.body));
    expect(payload.author).toBe("Bob");
    expect(Object.keys(payload.report).sort()).toEqual(["cases", "end", "format", "provenance", "start", "warnings"]);
    expect(String(init?.body)).not.toContain("window_name");
    return Response.json({ id: 7 }, { status: 201 });
  }) as typeof fetch;
  expect((await uploadDiscovery("https://hub.example", "team", "Bob", report, fetcher)).url).toBe("https://hub.example/decouvrir/7");
  await expect(uploadDiscovery("https://hub.example", "team", "Bob", report, (async () => Response.json({}, { status: 401 })) as unknown as typeof fetch)).rejects.toThrow("HTTP 401");
});

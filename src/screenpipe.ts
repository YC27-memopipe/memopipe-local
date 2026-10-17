import type { RecordingFixture, ScreenRecord } from "./types.ts";

export type Fetcher = typeof fetch;
type ContentType = "accessibility" | "ocr";
export function localBase(value = process.env.SCREENPIPE_LOCAL_API_URL ?? "http://localhost:3030"): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Screenpipe requires a loopback HTTP origin");
  return url;
}
function interval(start: string, end: string) {
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) throw new Error("Invalid search interval");
}
export function normalizeRecords(payload: unknown): ScreenRecord[] {
  const body = payload as { data?: unknown[] };
  if (!body || !Array.isArray(body.data)) throw new Error("Screenpipe response must contain data[]");
  return body.data.flatMap((row: any) => {
    const c = row?.content ?? row;
    const get = (name: string) => c?.[name] ?? row?.[`content.${name}`];
    // Screenpipe 0.4.52 emits the same frame identity as UI.content.id on accessibility.
    // Do not reinterpret IDs from audio/input records as frame IDs.
    const frame_id = get("frame_id") ?? (row?.type === "UI" ? get("id") : undefined);
    const timestamp = get("timestamp"), window_name = get("window_name"), text = get("text");
    if (!Number.isSafeInteger(frame_id) || frame_id < 0 || typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) || typeof window_name !== "string" || typeof text !== "string" || !text.trim()) return [];
    return [{ frame_id, timestamp, window_name, text }];
  });
}
export function fixtureRecords(fixture: RecordingFixture): ScreenRecord[] {
  if (fixture?.format !== "canary-screenpipe/v1" || !["recorded", "synthetic-demo"].includes(fixture.provenance) || !Array.isArray(fixture.pages) || !Number.isFinite(Date.parse(fixture.captured_at))) throw new Error("Invalid fixture format/provenance/timestamp");
  interval(fixture.start_time, fixture.end_time);
  const records: ScreenRecord[] = []; const seen = new Set<string>();
  for (const page of fixture.pages) {
    if (!page || typeof page.window_name !== "string" || !page.window_name.trim() || !["accessibility", "ocr"].includes(page.content_type) || !Number.isSafeInteger(page.offset) || page.offset < 0) throw new Error("Invalid fixture page");
    for (const record of normalizeRecords(page.response)) {
      checkScope([record], fixture.start_time, fixture.end_time, page.window_name);
      const signature = JSON.stringify(record);
      if (!seen.has(signature)) { records.push(record); seen.add(signature); }
    }
  }
  return records;
}
function checkScope(records: ScreenRecord[], start: string, end: string, window: string) {
  if (records.some(r => Date.parse(r.timestamp) < Date.parse(start) || Date.parse(r.timestamp) > Date.parse(end) || !r.window_name.includes(window))) throw new Error("Screenpipe returned records outside the consented interval/window");
}
export class ScreenpipeClient {
  private base: URL;
  constructor(private options: { base?: string; key?: string; fetcher?: Fetcher; timeoutMs?: number; maxPages?: number } = {}) { this.base = localBase(options.base); }
  private async get(path: string, authenticated: boolean): Promise<any> {
    const key = this.options.key ?? process.env.SCREENPIPE_LOCAL_API_KEY;
    if (authenticated && !key) throw new Error("Set SCREENPIPE_LOCAL_API_KEY (obtain privately with screenpipe auth token)");
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(new URL(path, this.base), {
        redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "X-Screenpipe-Client": "api", "X-Screenpipe-Agent": "canary" },
      });
    } catch { throw new Error("Screenpipe unreachable or request timed out; check local app and API URL"); }
    if (!response.ok) throw new Error(`Screenpipe HTTP ${response.status}${[401, 403].includes(response.status) ? ": check local API key" : ""}`);
    try { return await response.json(); } catch { throw new Error("Screenpipe returned invalid JSON"); }
  }
  async health(): Promise<{ captureActive: boolean; frameStatus?: string; uiRunning?: boolean }> {
    const value = await this.get("/health", false);
    if (!value || typeof value !== "object" || Array.isArray(value) || (typeof value.frame_status !== "string" && typeof value.ui_recorder?.running !== "boolean")) throw new Error("Invalid Screenpipe health response");
    return { captureActive: value.frame_status === "ok" || value.ui_recorder?.running === true, frameStatus: value.frame_status, uiRunning: value.ui_recorder?.running };
  }
  /** Caller must consent to these exact time/window bounds before search or history. */
  async search(start: string, end: string, window_name: string, content_type: ContentType, limit = 20): Promise<RecordingFixture["pages"]> {
    interval(start, end);
    if (!window_name.trim() || !["accessibility", "ocr"].includes(content_type) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid Screenpipe search parameters");
    const pages: RecordingFixture["pages"] = []; const seen = new Set<string>(); let offset = 0;
    for (let page = 0; ; page++) {
      if (page >= (this.options.maxPages ?? 500)) throw new Error("Pagination limit reached; narrow --since (no partial upload)");
      const params = new URLSearchParams({ start_time: start, end_time: end, window_name, content_type, limit: String(limit), offset: String(offset) });
      const response = await this.get(`/search?${params}`, true);
      const records = normalizeRecords(response);
      checkScope(records, start, end, window_name);
      pages.push({ window_name, content_type, offset, response });
      if (!response.data.length) return pages;
      const signature = JSON.stringify(response.data);
      if (seen.has(signature)) throw new Error("Screenpipe repeated a page; refusing incomplete pagination"); seen.add(signature);
      offset += response.data.length;
    }
  }
  async history(start: string, end: string): Promise<RecordingFixture> {
    interval(start, end);
    const fixture: RecordingFixture = { format: "canary-screenpipe/v1", provenance: "recorded", captured_at: new Date().toISOString(), start_time: start, end_time: end, pages: [] };
    for (const window_name of ["Tickets Nimbus", "Console des permissions"]) {
      for (const content_type of ["accessibility", "ocr"] as const) {
        const pages = await this.search(start, end, window_name, content_type);
        fixture.pages.push(...pages);
        if (pages.some(p => normalizeRecords(p.response).length)) break;
      }
    }
    return fixture;
  }
}

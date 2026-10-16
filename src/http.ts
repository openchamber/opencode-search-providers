import type { WebSearch } from "@opencode/plugin";

export type SearchResult = WebSearch.Result;

/** What a provider needs to make its request: injected so tests run without a network. */
export interface RequestContext {
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
}

/** Results per search; the built-in providers return about as many. */
export const MAX_RESULTS = 8;
/** Characters of page text kept per result, so one long page cannot fill the context. */
export const MAX_CONTENT_CHARS = 2000;
const TIMEOUT_MS = 25_000;
const ERROR_BODY_CHARS = 300;

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/**
 * Sends one request and returns the parsed JSON body. A non-2xx answer becomes
 * an error that names the provider and says what usually causes that status,
 * because the agent shows the message to the user as is.
 */
export async function requestJson(
  context: RequestContext,
  provider: string,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let response: Response;
  try {
    response = await context.fetch(url, {
      ...init,
      signal,
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (signal.aborted) throw new ProviderRequestError(`${provider} did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    throw new ProviderRequestError(`Could not reach ${provider}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).trim().slice(0, ERROR_BODY_CHARS);
    const message = [`${provider} answered HTTP ${response.status}.`, statusHint(response.status), body ? `Response: ${body}` : ""]
      .filter(Boolean)
      .join(" ");
    throw new ProviderRequestError(message, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderRequestError(`${provider} answered with something that is not JSON.`);
  }
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return "The API key was rejected or lacks access to this API.";
  if (status === 402) return "The account has no credits left.";
  if (status === 429) return "The rate limit or the plan's quota is used up.";
  if (status >= 500) return "The service had an internal error; try again later.";
  return "";
}

/** Reads `value` as an object, or `undefined` when it is anything else. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

/** Plain text from a snippet that may carry highlight tags and entities, cut to the content limit. */
export function cleanText(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const plain = text
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
    .trim();
  if (!plain) return undefined;
  return plain.length > MAX_CONTENT_CHARS ? `${plain.slice(0, MAX_CONTENT_CHARS).trimEnd()}…` : plain;
}

/** Milliseconds since the epoch for a date string, or `undefined` when it does not parse. */
export function parseTime(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

/** One result in OpenCode's shape, or `undefined` when it has no http(s) URL. */
export function toResult(input: { url: unknown; title?: unknown; content?: unknown; published?: unknown }): SearchResult | undefined {
  const url = asString(input.url);
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const title = cleanText(input.title);
  const content = cleanText(input.content);
  const published = parseTime(input.published);
  return {
    url,
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    time: published === undefined ? {} : { published },
  };
}

export function collect(items: unknown[], map: (item: Record<string, unknown>) => SearchResult | undefined): SearchResult[] {
  const results: SearchResult[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const result = record ? map(record) : undefined;
    if (result) results.push(result);
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

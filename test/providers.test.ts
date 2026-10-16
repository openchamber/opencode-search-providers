import { describe, expect, test } from "bun:test";
import { MAX_CONTENT_CHARS, ProviderRequestError } from "../src/http.ts";
import { brave, kagi, linkup, perplexity, searxng, searxngSearchUrl, serper, type SearchProvider } from "../src/providers.ts";

type Captured = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const run = (provider: SearchProvider, secret: string, fetch: typeof fetch) =>
  provider.search("opencode plugins", secret, { fetch, signal: new AbortController().signal });

const headers = (init: RequestInit) => new Headers(init.headers);

describe("searxng", () => {
  test("queries /search with the JSON format and maps results", async () => {
    const captured: Captured[] = [];
    const results = await run(
      searxng,
      "https://searx.example.org/",
      fakeFetch(200, {
        results: [
          { url: "https://a.example/1", title: "First", content: "Body", publishedDate: "2026-05-01T00:00:00" },
          { url: "javascript:alert(1)", title: "Dropped" },
          { url: "https://a.example/2", title: "Second", publishedDate: null },
        ],
      }, captured),
    );
    const url = new URL(captured[0]!.url);
    expect(url.origin + url.pathname).toBe("https://searx.example.org/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("q")).toBe("opencode plugins");
    expect(results).toEqual([
      { url: "https://a.example/1", title: "First", content: "Body", time: { published: Date.parse("2026-05-01T00:00:00") } },
      { url: "https://a.example/2", title: "Second", time: {} },
    ]);
  });

  test("accepts an address that already ends in /search or sits under a path", () => {
    expect(searxngSearchUrl("https://searx.example.org/search").toString()).toBe("https://searx.example.org/search");
    expect(searxngSearchUrl("http://host:8080/searx/").toString()).toBe("http://host:8080/searx/search");
  });

  test("rejects an address that is not http(s)", () => {
    expect(() => searxngSearchUrl("ftp://host")).toThrow(ProviderRequestError);
    expect(() => searxngSearchUrl("not a url")).toThrow(ProviderRequestError);
  });

  test("explains a 403 as the JSON format being disabled", async () => {
    await expect(run(searxng, "https://searx.example.org", fakeFetch(403, "Forbidden"))).rejects.toThrow(/search\.formats/);
  });
});

describe("brave", () => {
  test("sends the key header and strips highlight markup", async () => {
    const captured: Captured[] = [];
    const results = await run(
      brave,
      "brave-key",
      fakeFetch(200, {
        web: { results: [{ url: "https://b.example", title: "<strong>Brave</strong> &amp; co", description: "A <strong>hit</strong>", page_age: "2026-01-02T03:04:05" }] },
      }, captured),
    );
    expect(captured[0]!.url).toStartWith("https://api.search.brave.com/res/v1/web/search?");
    expect(headers(captured[0]!.init).get("X-Subscription-Token")).toBe("brave-key");
    expect(results).toEqual([
      { url: "https://b.example", title: "Brave & co", content: "A hit", time: { published: Date.parse("2026-01-02T03:04:05") } },
    ]);
  });

  test("returns no results when the answer has no web section", async () => {
    expect(await run(brave, "k", fakeFetch(200, { query: {} }))).toEqual([]);
  });
});

describe("kagi", () => {
  test("posts the query with a bearer key and reads data.search", async () => {
    const captured: Captured[] = [];
    const results = await run(
      kagi,
      "kagi-key",
      fakeFetch(200, { data: { search: [{ url: "https://k.example", title: "Kagi", snippet: "Snippet", time: "2024-11-29T03:54:26Z" }] } }, captured),
    );
    expect(captured[0]!.url).toBe("https://kagi.com/api/v1/search");
    expect(headers(captured[0]!.init).get("Authorization")).toBe("Bearer kagi-key");
    expect(JSON.parse(String(captured[0]!.init.body))).toEqual({ query: "opencode plugins", limit: 8 });
    expect(results).toEqual([{ url: "https://k.example", title: "Kagi", content: "Snippet", time: { published: Date.parse("2024-11-29T03:54:26Z") } }]);
  });
});

describe("perplexity", () => {
  test("cuts long snippets and falls back to last_updated", async () => {
    const results = await run(
      perplexity,
      "pplx",
      fakeFetch(200, { results: [{ url: "https://p.example", title: "P", snippet: "x".repeat(MAX_CONTENT_CHARS + 50), date: null, last_updated: "2026-05-21" }] }),
    );
    expect(results[0]!.content!.length).toBe(MAX_CONTENT_CHARS + 1);
    expect(results[0]!.time.published).toBe(Date.parse("2026-05-21"));
  });
});

describe("linkup", () => {
  test("asks for search results and skips image results", async () => {
    const captured: Captured[] = [];
    const results = await run(
      linkup,
      "lk",
      fakeFetch(200, {
        results: [
          { type: "image", name: "Img", url: "https://l.example/img.png" },
          { type: "text", name: "Text", url: "https://l.example", content: "Content", favicon: "" },
        ],
      }, captured),
    );
    expect(JSON.parse(String(captured[0]!.init.body))).toEqual({ q: "opencode plugins", depth: "fast", outputType: "searchResults", maxResults: 8 });
    expect(results).toEqual([{ url: "https://l.example", title: "Text", content: "Content", time: {} }]);
  });
});

describe("serper", () => {
  test("reads organic results and ignores relative dates", async () => {
    const captured: Captured[] = [];
    const results = await run(
      serper,
      "sp",
      fakeFetch(200, { organic: [{ link: "https://s.example", title: "S", snippet: "Snip", date: "3 days ago" }] }, captured),
    );
    expect(headers(captured[0]!.init).get("X-API-KEY")).toBe("sp");
    expect(results).toEqual([{ url: "https://s.example", title: "S", content: "Snip", time: {} }]);
  });
});

describe("errors", () => {
  test("a rejected key names the provider and the cause", async () => {
    const error = await run(brave, "bad", fakeFetch(401, { error: "invalid token" })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as ProviderRequestError).status).toBe(401);
    expect((error as Error).message).toContain("Brave Search answered HTTP 401");
    expect((error as Error).message).toContain("API key was rejected");
  });

  test("a body that is not JSON is reported as such", async () => {
    await expect(run(serper, "k", fakeFetch(200, "<html>"))).rejects.toThrow(/not JSON/);
  });

  test("a network failure says the provider could not be reached", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(run(kagi, "k", failing)).rejects.toThrow(/Could not reach Kagi: fetch failed/);
  });
});

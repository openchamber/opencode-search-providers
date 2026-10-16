import { describe, expect, test } from "bun:test";
import type { Credential, Plugin } from "@opencode/plugin";
import plugin, { secretOf, WEBSEARCH_INTEGRATION_METADATA } from "../src/index.ts";
import { brave, searxng } from "../src/providers.ts";

type WebSearchDefinition = { id: string; name: string; execute: (input: { query: string }, context: { signal: AbortSignal }) => Promise<unknown> };

/** Just enough of OpenCode's plugin context: integrations, credentials, websearch and the event stream. */
function fakeHost(initial: Record<string, Credential.Value>) {
  const credentials = new Map(Object.entries(initial));
  const integrations = new Map<string, { id: string; name: string; metadata?: unknown; methods: unknown[] }>();
  let websearchTransform: ((editor: { add: (definition: WebSearchDefinition) => void }) => void) | undefined;
  let registered: WebSearchDefinition[] = [];
  let reloads = 0;
  const queue: { type: string }[] = [];
  let wake: (() => void) | undefined;

  const runWebsearch = () => {
    registered = [];
    websearchTransform?.({ add: (definition) => registered.push(definition) });
  };

  const ctx = {
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          update: (id: string, update: (ref: { id: string; name: string }) => void) => {
            const entry = integrations.get(id) ?? { id, name: id, methods: [] };
            integrations.set(id, entry);
            update(entry);
          },
          method: {
            update: (input: { integrationID: string; method: unknown }) => integrations.get(input.integrationID)?.methods.push(input.method),
          },
        });
      },
      connection: {
        active: async (id: string) => (credentials.has(id) ? { type: "credential", id } : undefined),
        resolve: async (connection: { id: string }) => credentials.get(connection.id),
      },
    },
    websearch: {
      transform: async (callback: typeof websearchTransform) => {
        websearchTransform = callback;
        runWebsearch();
      },
      reload: async () => {
        reloads += 1;
        runWebsearch();
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      }),
    },
  };

  return {
    ctx: ctx as unknown as Plugin.Context,
    credentials,
    integrations,
    registered: () => registered.map((definition) => definition.id),
    definition: (id: string) => registered.find((definition) => definition.id === id),
    reloads: () => reloads,
    emit: async (type: string) => {
      queue.push({ type });
      wake?.();
      // Let the stream deliver and the refresh read the credentials.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

const key = (value: string): Credential.Value => ({ type: "key", key: value }) as Credential.Value;

describe("plugin", () => {
  test("marks every integration as web search and registers only connected providers", async () => {
    const host = fakeHost({ brave: key("bk") });
    const cleanup = await plugin.setup(host.ctx);

    expect([...host.integrations.keys()].sort()).toEqual(["brave", "kagi", "linkup", "perplexity-search", "searxng", "serper"]);
    for (const integration of host.integrations.values()) expect(integration.metadata).toEqual(WEBSEARCH_INTEGRATION_METADATA);
    expect(host.integrations.get("searxng")!.methods).toContainEqual(expect.objectContaining({ type: "external", id: "server" }));
    expect(host.integrations.get("brave")!.methods).toContainEqual({ type: "env", names: ["BRAVE_API_KEY"] });
    expect(host.registered()).toEqual(["brave"]);

    if (typeof cleanup === "function") await cleanup();
  });

  test("adds a provider when its credential arrives and drops it when removed", async () => {
    const host = fakeHost({});
    const cleanup = await plugin.setup(host.ctx);
    expect(host.registered()).toEqual([]);

    host.credentials.set("searxng", { type: "external", methodID: "server", metadata: { url: "https://searx.example.org" } } as Credential.Value);
    await host.emit("credential.updated");
    expect(host.registered()).toEqual(["searxng"]);
    expect(host.reloads()).toBe(1);

    // An unrelated event with nothing changed does not reload.
    await host.emit("integration.updated");
    expect(host.reloads()).toBe(1);

    host.credentials.delete("searxng");
    await host.emit("credential.updated");
    expect(host.registered()).toEqual([]);
    expect(host.reloads()).toBe(2);

    if (typeof cleanup === "function") await cleanup();
  });

  test("a search after the key was removed explains what is missing", async () => {
    const host = fakeHost({ brave: key("bk") });
    const cleanup = await plugin.setup(host.ctx);
    const definition = host.definition("brave")!;
    host.credentials.delete("brave");
    await expect(definition.execute({ query: "q" }, { signal: new AbortController().signal })).rejects.toThrow(/Brave Search is not connected.*BRAVE_API_KEY/);
    if (typeof cleanup === "function") await cleanup();
  });
});

describe("secretOf", () => {
  test("reads the server URL from the form answer or from the environment variable", () => {
    expect(secretOf(searxng, { type: "external", methodID: "server", metadata: { url: " https://s.example " } } as Credential.Value)).toBe("https://s.example");
    expect(secretOf(searxng, key("http://localhost:8888"))).toBe("http://localhost:8888");
    expect(secretOf(searxng, { type: "external", methodID: "server" } as Credential.Value)).toBeUndefined();
  });

  test("a key provider ignores anything but a key", () => {
    expect(secretOf(brave, key("bk"))).toBe("bk");
    expect(secretOf(brave, key("  "))).toBeUndefined();
    expect(secretOf(brave, { type: "external", methodID: "x", metadata: { url: "u" } } as Credential.Value)).toBeUndefined();
  });
});

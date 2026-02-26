import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";
import { Mem0Adapter } from "../src/mem0-client.js";
import {
  createStatePaths,
  readCaptureDedupeState,
  readLifecycleState,
  readStatsState,
  writeLifecycleState,
} from "../src/state.js";

let tempDir = "";

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

function createApi(params?: {
  stateDir?: string;
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
}) {
  const tools: Array<{ factory: unknown; options?: unknown }> = [];
  const hooks: Array<{ name: string; handler: unknown }> = [];
  const services: Array<{ id: string; start: (ctx: unknown) => Promise<void> | void }> = [];
  const commands: Array<{ name: string; handler: (ctx: unknown) => Promise<unknown> | unknown }> =
    [];

  const api = {
    pluginConfig: params?.pluginConfig ?? {},
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    config:
      params?.config ??
      {
        agents: {
          defaults: {
            workspace: "/tmp",
          },
        },
      },
    runtime: {
      state: {
        resolveStateDir: () => params?.stateDir ?? "/tmp/.openclaw",
      },
      tools: {
        createMemorySearchTool: () => ({
          name: "memory_search",
          parameters: {},
          execute: async () => ({
            details: { results: [] },
            content: [{ type: "text", text: "{}" }],
          }),
        }),
        createMemoryGetTool: () => ({
          name: "memory_get",
          execute: async () => ({
            details: { path: "", text: "" },
            content: [{ type: "text", text: "{}" }],
          }),
        }),
      },
    },
    registerTool: (factory: unknown, options?: unknown) => {
      tools.push({ factory, options });
    },
    on: (name: string, handler: unknown) => {
      hooks.push({ name, handler });
    },
    registerService: (service: { id: string; start: (ctx: unknown) => Promise<void> | void }) => {
      services.push(service);
    },
    registerCommand: (command: {
      name: string;
      handler: (ctx: unknown) => Promise<unknown> | unknown;
    }) => {
      commands.push({ name: command.name, handler: command.handler });
    },
  };

  return { api, tools, hooks, services, commands };
}

describe("memory-braid plugin", () => {
  it("registers tools, hooks, and service", async () => {
    const { api, tools, hooks, services, commands } = createApi();

    await plugin.register(api as never);

    expect(tools).toHaveLength(1);
    expect(hooks.map((item) => item.name)).toEqual(
      expect.arrayContaining(["before_agent_start", "agent_end"]),
    );
    expect(services.map((service) => service.id)).toContain("memory-braid-service");
    expect(commands.map((command) => command.name)).toContain("memorybraid");
  });

  it("does not mark capture dedupe hash when mem0 add returns no id", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({});
    const { api, hooks } = createApi({ stateDir });

    await plugin.register(api as never);
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;
    expect(agentEndHook).toBeTypeOf("function");

    await agentEndHook!(
      {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember that my timezone is PST and I prefer afternoon standups.",
          },
        ],
      },
      {
        workspaceDir: path.join(tempDir, "workspace"),
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(addSpy).toHaveBeenCalledTimes(1);
    const dedupe = await readCaptureDedupeState(createStatePaths(stateDir));
    expect(Object.keys(dedupe.seen)).toHaveLength(0);
  });

  it("applies memory-core temporal decay config to mem0 ranking when enabled", async () => {
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        source: "mem0",
        snippet: "Older memory with higher raw score",
        score: 0.95,
        metadata: { indexedAt: "2025-01-01T00:00:00.000Z" },
      },
      {
        source: "mem0",
        snippet: "Recent memory with lower raw score",
        score: 0.8,
        metadata: { indexedAt: "2026-02-20T00:00:00.000Z" },
      },
    ]);

    const { api, tools } = createApi({
      pluginConfig: {
        timeDecay: {
          enabled: true,
        },
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
      config: {
        agents: {
          defaults: {
            workspace: "/tmp",
            memorySearch: {
              query: {
                hybrid: {
                  temporalDecay: {
                    enabled: true,
                    halfLifeDays: 30,
                  },
                },
              },
            },
          },
        },
      },
    });

    await plugin.register(api as never);
    const factory = tools[0]?.factory as ((ctx: unknown) => Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>) | undefined;
    expect(factory).toBeTypeOf("function");
    const boundTools = factory!({
      config: api.config,
      workspaceDir: "/tmp",
      agentId: "main",
      sessionKey: "s1",
    });
    const searchTool = boundTools.find((tool) => tool.name === "memory_search");
    expect(searchTool).toBeTruthy();

    const output = await searchTool!.execute("call-1", { query: "memory" });
    const details = (output as { details?: { results?: Array<{ snippet?: string }> } }).details;
    const snippets = (details?.results ?? []).map((entry) => entry.snippet);

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(snippets[0]).toContain("Recent memory");
  });

  it("reports capture counters via /memorybraid stats", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const { api, hooks, commands } = createApi({ stateDir });

    await plugin.register(api as never);
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;
    expect(agentEndHook).toBeTypeOf("function");

    await agentEndHook!(
      {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember that my timezone is PST and I prefer afternoon standups.",
          },
        ],
      },
      {
        workspaceDir: path.join(tempDir, "workspace"),
        agentId: "main",
        sessionKey: "s1",
      },
    );

    const command = commands.find((entry) => entry.name === "memorybraid");
    expect(command).toBeTruthy();
    const commandResult = (await command!.handler({
      args: "stats",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/memorybraid stats",
      config: api.config,
    })) as { text?: string };

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(commandResult.text).toContain("Memory Braid stats");
    expect(commandResult.text).toContain("mem0AddAttempts: 1");
    expect(commandResult.text).toContain("mem0AddWithId: 1");

    const stats = await readStatsState(createStatePaths(stateDir));
    expect(stats.capture.mem0AddAttempts).toBe(1);
    expect(stats.capture.mem0AddWithId).toBe(1);
  });

  it("tracks capture IDs in lifecycle state and reinforces on recall", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const workspaceDir = path.join(tempDir, "workspace");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        id: "m-1",
        source: "mem0",
        snippet: "User prefers afternoon standups.",
        score: 0.9,
      },
    ]);
    const { api, hooks, tools } = createApi({
      stateDir,
      pluginConfig: {
        lifecycle: {
          enabled: true,
        },
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;
    expect(agentEndHook).toBeTypeOf("function");

    await agentEndHook!(
      {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember that I prefer afternoon standups.",
          },
        ],
      },
      {
        workspaceDir,
        agentId: "main",
        sessionKey: "s1",
      },
    );

    let lifecycle = await readLifecycleState(createStatePaths(stateDir));
    expect(lifecycle.entries["m-1"]).toBeTruthy();
    expect(lifecycle.entries["m-1"]?.recallCount).toBe(0);

    const factory = tools[0]?.factory as
      | ((ctx: unknown) => Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>)
      | undefined;
    expect(factory).toBeTypeOf("function");
    const boundTools = factory!({
      config: api.config,
      workspaceDir,
      agentId: "main",
      sessionKey: "s1",
    });
    const searchTool = boundTools.find((tool) => tool.name === "memory_search");
    expect(searchTool).toBeTruthy();

    await searchTool!.execute("call-1", { query: "standups" });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    lifecycle = await readLifecycleState(createStatePaths(stateDir));
    expect(lifecycle.entries["m-1"]?.recallCount).toBe(1);
    expect(lifecycle.entries["m-1"]?.lastRecalledAt).toBeTypeOf("number");
  });

  it("deletes expired lifecycle memories via /memorybraid cleanup", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const workspaceDir = path.join(tempDir, "workspace");
    const deleteSpy = vi.spyOn(Mem0Adapter.prototype, "deleteMemory").mockResolvedValue(true);
    const { api, commands } = createApi({
      stateDir,
      pluginConfig: {
        lifecycle: {
          enabled: true,
          captureTtlDays: 1,
        },
      },
    });

    await plugin.register(api as never);
    const statePaths = createStatePaths(stateDir);
    const now = Date.now();
    await writeLifecycleState(statePaths, {
      version: 1,
      entries: {
        stale: {
          memoryId: "stale",
          contentHash: "hash-stale",
          workspaceHash: "ws-1",
          agentId: "main",
          sessionKey: "s1",
          category: "fact",
          createdAt: now - 3 * 24 * 60 * 60 * 1000,
          lastCapturedAt: now - 2 * 24 * 60 * 60 * 1000,
          recallCount: 0,
          updatedAt: now - 2 * 24 * 60 * 60 * 1000,
        },
        fresh: {
          memoryId: "fresh",
          contentHash: "hash-fresh",
          workspaceHash: "ws-1",
          agentId: "main",
          sessionKey: "s2",
          category: "fact",
          createdAt: now - 12 * 60 * 60 * 1000,
          lastCapturedAt: now - 12 * 60 * 60 * 1000,
          recallCount: 0,
          updatedAt: now - 12 * 60 * 60 * 1000,
        },
      },
    });

    const command = commands.find((entry) => entry.name === "memorybraid");
    expect(command).toBeTruthy();
    const result = (await command!.handler({
      args: "cleanup",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/memorybraid cleanup",
      workspaceDir,
      config: api.config,
    })) as { text?: string };

    expect(result.text).toContain("Lifecycle cleanup complete.");
    expect(result.text).toContain("expired: 1");
    expect(result.text).toContain("deleted: 1");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "stale",
      }),
    );

    const lifecycle = await readLifecycleState(statePaths);
    expect(lifecycle.entries.stale).toBeUndefined();
    expect(lifecycle.entries.fresh).toBeTruthy();
    expect(lifecycle.lastCleanupDeleted).toBe(1);
    expect(lifecycle.lastCleanupExpired).toBe(1);
  });
});

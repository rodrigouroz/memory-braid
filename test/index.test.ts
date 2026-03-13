import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";
import { Mem0Adapter } from "../src/mem0-client.js";
import {
  createStatePaths,
  readCaptureDedupeState,
  readConsolidationState,
  readLifecycleState,
  readRemediationState,
  readStatsState,
  withStateLock,
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
  localSearchResults?: unknown[];
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
            details: { results: params?.localSearchResults ?? [] },
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

function getBoundTools(
  tools: Array<{ factory: unknown; options?: unknown }>,
  ctx: Record<string, unknown>,
) {
  const out: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  for (const entry of tools) {
    const factory = entry.factory;
    if (typeof factory === "function") {
      const value = factory(ctx);
      if (Array.isArray(value)) {
        out.push(...value);
      } else if (value) {
        out.push(value);
      }
      continue;
    }
    if (factory && typeof factory === "object") {
      out.push(factory as { name: string; execute: (...args: unknown[]) => Promise<unknown> });
    }
  }
  return out;
}

describe("memory-braid plugin", () => {
  it("registers tools, hooks, and service", async () => {
    const { api, tools, hooks, services, commands } = createApi();

    await plugin.register(api as never);

    const boundTools = getBoundTools(tools, {
      config: api.config,
      workspaceDir: "/tmp",
      agentId: "main",
      sessionKey: "s1",
    });
    expect(boundTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["memory_search", "memory_get", "remember_learning"]),
    );
    expect(hooks.map((item) => item.name)).toEqual(
      expect.arrayContaining(["before_agent_start", "before_message_write", "agent_end"]),
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

  it("captures only the trusted external user turn instead of the full transcript", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const { api, hooks } = createApi({ stateDir });

    await plugin.register(api as never);
    const beforeWrite = hooks.find((entry) => entry.name === "before_message_write")?.handler as
      | ((event: unknown) => Promise<void>)
      | undefined;
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;

    await beforeWrite?.({
      agentId: "main",
      sessionKey: "s1",
      message: {
        role: "user",
        provenance: { kind: "external_user" },
        content: [{ type: "text", text: "Remember that I prefer black coffee in the morning." }],
      },
    });

    await agentEndHook?.(
      {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "System: imported wrapper\n\nConversation info:\n```json\n{\"sender\":\"Rod\"}\n```",
          },
          {
            role: "assistant",
            content: "Earlier assistant note that should not be captured.",
          },
          {
            role: "toolResult",
            content: "Remember that secret tool results exist.",
          },
          {
            role: "assistant",
            content: "Noted.",
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
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Remember that I prefer black coffee in the morning.",
        scope: {
          workspaceHash: expect.any(String),
          agentId: "main",
        },
        metadata: expect.objectContaining({
          memoryOwner: "user",
          memoryLayer: "episodic",
          captureOrigin: "external_user",
          capturePath: "before_message_write",
          selectionDecision: "episodic",
          rememberabilityScore: expect.any(Number),
          eventAt: expect.any(String),
          firstSeenAt: expect.any(String),
          lastSeenAt: expect.any(String),
          taxonomy: expect.any(Object),
        }),
      }),
    );
  });

  it("captures only trailing assistant content from the current turn when includeAssistant is enabled", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const { api, hooks } = createApi({
      stateDir,
      pluginConfig: {
        capture: {
          includeAssistant: true,
          assistant: {
            minUtilityScore: 0.6,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeWrite = hooks.find((entry) => entry.name === "before_message_write")?.handler as
      | ((event: unknown) => Promise<void>)
      | undefined;
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;

    await beforeWrite?.({
      agentId: "main",
      sessionKey: "s1",
      message: {
        role: "user",
        provenance: { kind: "external_user" },
        content: [{ type: "text", text: "short note" }],
      },
    });

    await agentEndHook?.(
      {
        success: true,
        messages: [
          {
            role: "assistant",
            content: "Remember that we used to deploy every Tuesday afternoon.",
          },
          {
            role: "user",
            content: "short note",
          },
          {
            role: "assistant",
            content:
              "Remember that we decided we will use Friday afternoon deploys and keep that strategy for release planning.",
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
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Friday afternoon deploys"),
        metadata: expect.objectContaining({
          sourceType: "agent_learning",
          memoryOwner: "agent",
          captureOrigin: "assistant_derived",
        }),
      }),
    );
  });

  it("persists remember_learning in workspace scope with agent metadata", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "learn-1" });
    vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([]);
    const { api, tools } = createApi({ stateDir: path.join(tempDir, "state") });

    await plugin.register(api as never);
    const boundTools = getBoundTools(tools, {
      config: api.config,
      workspaceDir: path.join(tempDir, "workspace"),
      agentId: "main",
      sessionKey: "s1",
    });
    const tool = boundTools.find((entry) => entry.name === "remember_learning");
    expect(tool).toBeTruthy();

    const result = (await tool!.execute("call-1", {
      text: "Prefer strict lexical gating before semantic dedupe to avoid unnecessary Mem0 similarity calls.",
      kind: "heuristic",
      recallTarget: "planning",
    })) as { details?: Record<string, unknown> };

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          workspaceHash: expect.any(String),
          agentId: "main",
        },
        metadata: expect.objectContaining({
          sourceType: "agent_learning",
          memoryLayer: "procedural",
          memoryOwner: "agent",
          memoryKind: "heuristic",
          captureIntent: "explicit_tool",
          recallTarget: "planning",
          sessionKey: "s1",
        }),
      }),
    );
    expect(result.details).toMatchObject({
      accepted: true,
      memoryId: "learn-1",
    });
  });

  it("rejects oversized remember_learning payloads", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "learn-1" });
    vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([]);
    const { api, tools } = createApi({ stateDir: path.join(tempDir, "state") });

    await plugin.register(api as never);
    const boundTools = getBoundTools(tools, {
      config: api.config,
      workspaceDir: path.join(tempDir, "workspace"),
      agentId: "main",
      sessionKey: "s1",
    });
    const tool = boundTools.find((entry) => entry.name === "remember_learning");
    const longText = "Avoid expensive duplicate similarity scans. ".repeat(80);

    const result = (await tool!.execute("call-1", {
      text: longText,
      kind: "lesson",
    })) as { details?: Record<string, unknown> };

    expect(addSpy).toHaveBeenCalledTimes(0);
    expect(result.details).toMatchObject({
      accepted: false,
      reason: "oversized",
    });
  });

  it("falls back to the last user turn and ignores earlier history and tool results", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const { api, hooks } = createApi({ stateDir });

    await plugin.register(api as never);
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;

    await agentEndHook?.(
      {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember that my old favorite drink was orange juice.",
          },
          {
            role: "assistant",
            content: "Remember that we used to deploy every Tuesday afternoon.",
          },
          {
            role: "toolResult",
            content: "Remember that tool outputs can contain all sorts of junk.",
          },
          {
            role: "user",
            content: "Remember that I prefer afternoon standups.",
          },
          {
            role: "assistant",
            content: "Noted.",
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
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Remember that I prefer afternoon standups.",
        metadata: expect.objectContaining({
          capturePath: "agent_end_last_turn",
        }),
      }),
    );
  });

  it("skips low-value one-off task captures via deterministic selection", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const { api, hooks } = createApi({ stateDir });

    await plugin.register(api as never);
    const beforeWrite = hooks.find((entry) => entry.name === "before_message_write")?.handler as
      | ((event: unknown) => Promise<void>)
      | undefined;
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;

    await beforeWrite?.({
      agentId: "main",
      sessionKey: "s1",
      message: {
        role: "user",
        provenance: { kind: "external_user" },
        content: [{ type: "text", text: "Todo: send the invoice tomorrow." }],
      },
    });

    await agentEndHook?.(
      {
        success: true,
        messages: [],
      },
      {
        workspaceDir: path.join(tempDir, "workspace"),
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(addSpy).toHaveBeenCalledTimes(0);
    const stats = await readStatsState(createStatePaths(stateDir));
    expect(stats.capture.selectionSkipped).toBe(1);
  });

  it("rejects pasted multi-speaker transcripts from capture", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const { api, hooks } = createApi({ stateDir });

    await plugin.register(api as never);
    const beforeWrite = hooks.find((entry) => entry.name === "before_message_write")?.handler as
      | ((event: unknown) => Promise<void>)
      | undefined;
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;

    await beforeWrite?.({
      agentId: "main",
      sessionKey: "s1",
      message: {
        role: "user",
        provenance: { kind: "external_user" },
        content: [
          {
            type: "text",
            text: "User: I prefer black coffee.\nAssistant: Noted.\nUser: Deploy every Friday afternoon.",
          },
        ],
      },
    });

    await agentEndHook?.(
      {
        success: true,
        messages: [],
      },
      {
        workspaceDir: path.join(tempDir, "workspace"),
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(addSpy).toHaveBeenCalledTimes(0);
    const stats = await readStatsState(createStatePaths(stateDir));
    expect(stats.capture.transcriptShapeSkipped).toBeGreaterThanOrEqual(0);
  });

  it("does not hold the state lock while mem0 add is in flight", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    let releaseAdd: (() => void) | undefined;
    let addStarted: (() => void) | undefined;
    const addInFlight = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const addStartedPromise = new Promise<void>((resolve) => {
      addStarted = resolve;
    });
    vi.spyOn(Mem0Adapter.prototype, "addMemory").mockImplementation(async () => {
      addStarted?.();
      await addInFlight;
      return { id: "m-1" };
    });
    const { api, hooks } = createApi({ stateDir });

    await plugin.register(api as never);
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;
    expect(agentEndHook).toBeTypeOf("function");

    const runPromise = agentEndHook!(
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

    await addStartedPromise;
    const paths = createStatePaths(stateDir);
    await expect(
      withStateLock(
        paths.stateLockFile,
        async () => undefined,
        { retries: 0 },
      ),
    ).resolves.toBeUndefined();

    releaseAdd?.();
    await runPromise;
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
    const boundTools = getBoundTools(tools, {
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

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(snippets[0]).toContain("Recent memory");
  });

  it("filters irrelevant generic summaries from injected memories", async () => {
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        source: "mem0",
        snippet: "The user asked about reembolso in drapp and Seer ecosystem updates.",
        score: 0.98,
        metadata: { category: "other", indexedAt: "2026-02-25T12:00:00.000Z" },
      },
      {
        source: "mem0",
        snippet:
          "Implement memory-braid relevance gating so only overlapping memories are injected.",
        score: 0.72,
        metadata: { category: "decision", sessionKey: "s1", indexedAt: "2026-02-25T12:00:00.000Z" },
      },
      {
        source: "mem0",
        snippet: "Apply mem0 relevance ranking with session-aware boosts and category-age penalties.",
        score: 0.7,
        metadata: { category: "decision", sessionKey: "s1", indexedAt: "2026-02-25T12:00:00.000Z" },
      },
    ]);
    const { api, hooks } = createApi({
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;
    expect(beforeAgentStart).toBeTypeOf("function");

    const result = await beforeAgentStart!(
      {
        prompt: "Implement memory-braid relevance gating and mem0 relevance ranking fixes",
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(result && "prependContext" in result ? result.prependContext : "").toContain(
      "relevance gating",
    );
    expect(result && "prependContext" in result ? result.prependContext : "").toContain(
      "session-aware boosts",
    );
    expect(result && "prependContext" in result ? result.prependContext : "").not.toContain(
      "reembolso",
    );
  });

  it("injects separated user memories and agent learnings with stable system prompt", async () => {
    const searchSpy = vi
      .spyOn(Mem0Adapter.prototype, "searchMemories")
      .mockResolvedValueOnce([
        {
          source: "mem0",
          snippet: "Prefers afternoon standups for planning.",
          score: 0.88,
          metadata: {
            memoryOwner: "user",
            memoryKind: "preference",
            indexedAt: "2026-02-25T12:00:00.000Z",
          },
        },
        {
          source: "mem0",
          snippet: "Prefer strict relevance gating before injecting agent learnings into planning context.",
          score: 0.92,
          metadata: {
            memoryOwner: "agent",
            memoryKind: "heuristic",
            recallTarget: "planning",
            indexedAt: "2026-02-25T12:00:00.000Z",
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          source: "mem0",
          snippet: "Prefers afternoon standups for planning.",
          score: 0.88,
          metadata: {
            memoryOwner: "user",
            memoryKind: "preference",
            indexedAt: "2026-02-25T12:00:00.000Z",
          },
        },
        {
          source: "mem0",
          snippet: "Prefer strict relevance gating before injecting agent learnings into planning context.",
          score: 0.92,
          metadata: {
            memoryOwner: "agent",
            memoryKind: "heuristic",
            recallTarget: "planning",
            indexedAt: "2026-02-25T12:00:00.000Z",
          },
        },
      ])
      .mockResolvedValueOnce([]);
    const { api, hooks } = createApi({
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string; systemPrompt?: string } | void>)
      | undefined;

    const first = await beforeAgentStart!(
      {
        prompt: "Help me with planning standups and reduce noisy learnings",
        messages: [
          { role: "user", content: "Help me with planning standups and reduce noisy learnings" },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s1",
      },
    );
    const second = await beforeAgentStart!(
      {
        prompt: "Help me with planning standups and reduce noisy learnings",
        messages: [
          { role: "user", content: "Help me with planning standups and reduce noisy learnings" },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s2",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(4);
    expect(first && "systemPrompt" in first ? first.systemPrompt : "").toContain(
      "remember_learning",
    );
    expect(first && "systemPrompt" in first ? first.systemPrompt : "").toBe(
      second && "systemPrompt" in second ? second.systemPrompt : "",
    );
    expect(first && "prependContext" in first ? first.prependContext : "").toContain(
      "<user-memories>",
    );
    expect(first && "prependContext" in first ? first.prependContext : "").toContain(
      "<agent-learnings>",
    );
  });

  it("falls back to legacy session-scoped mem0 recall without migration", async () => {
    const searchSpy = vi
      .spyOn(Mem0Adapter.prototype, "searchMemories")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          source: "mem0",
          snippet: "Prefers black coffee in the morning.",
          score: 0.86,
          metadata: {
            captureOrigin: "external_user",
            indexedAt: "2026-02-25T12:00:00.000Z",
          },
        },
      ]);
    const { api, hooks } = createApi({
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;
    const result = await beforeAgentStart!(
      {
        prompt: "I need the black coffee preference from memory.",
        messages: [{ role: "user", content: "I need the black coffee preference from memory." }],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "legacy-session",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({
      scope: {
        workspaceHash: expect.any(String),
        agentId: "main",
      },
    });
    expect(searchSpy.mock.calls[1]?.[0]).toMatchObject({
      scope: {
        workspaceHash: expect.any(String),
        agentId: "main",
        sessionKey: "legacy-session",
      },
    });
    expect(result && "prependContext" in result ? result.prependContext : "").toContain(
      "black coffee",
    );
  });

  it("uses the latest normalized user turn as the recall query before falling back to prompt", async () => {
    const searchSpy = vi
      .spyOn(Mem0Adapter.prototype, "searchMemories")
      .mockResolvedValueOnce([
        {
          source: "mem0",
          snippet: "User prefers black coffee in the morning.",
          score: 0.9,
          metadata: {
            memoryOwner: "user",
            memoryKind: "preference",
            indexedAt: "2026-02-25T12:00:00.000Z",
          },
        },
      ])
      .mockResolvedValueOnce([]);
    const { api, hooks } = createApi({
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;

    const result = await beforeAgentStart!(
      {
        prompt:
          "telegram envelope username rodrigonu date 1700000000 black coffee preference from a broader prompt wrapper",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              message_id: 123,
              date: 1700000000,
              chat: { id: 999, username: "rodrigonu" },
              text: "Remember that I prefer black coffee in the morning.",
            }),
          },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({
      query: "Remember that I prefer black coffee in the morning.",
    });
    expect(result && "prependContext" in result ? result.prependContext : "").toContain(
      "black coffee",
    );
  });

  it("prefers in-range episodic memories for time-bounded recall prompts", async () => {
    const searchSpy = vi
      .spyOn(Mem0Adapter.prototype, "searchMemories")
      .mockResolvedValueOnce([
        {
          id: "ep-june",
          source: "mem0",
          snippet: "We discussed moving standups to afternoons in June 2025.",
          score: 0.71,
          metadata: {
            sourceType: "capture",
            memoryLayer: "episodic",
            memoryOwner: "user",
            memoryKind: "decision",
            eventAt: "2025-06-14T12:00:00.000Z",
          },
        },
        {
          id: "ep-march",
          source: "mem0",
          snippet: "We discussed sprint planning in March 2026.",
          score: 0.95,
          metadata: {
            sourceType: "capture",
            memoryLayer: "episodic",
            memoryOwner: "user",
            memoryKind: "decision",
            eventAt: "2026-03-10T12:00:00.000Z",
          },
        },
        {
          id: "sem-general",
          source: "mem0",
          snippet: "Decision: Standups work best in the afternoon.",
          score: 0.9,
          metadata: {
            sourceType: "compendium",
            memoryLayer: "semantic",
            memoryOwner: "user",
            memoryKind: "decision",
            lastSeenAt: "2026-03-01T12:00:00.000Z",
          },
        },
      ])
      .mockResolvedValueOnce([]);
    const { api, hooks } = createApi({
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;

    const result = await beforeAgentStart!(
      {
        prompt: "What did we discuss in June?",
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(result && "prependContext" in result ? result.prependContext : "").toContain(
      "June 2025",
    );
    expect(result && "prependContext" in result ? result.prependContext : "").not.toContain(
      "March 2026",
    );
  });

  it("injects only mem0 recall and ignores local-only matches", async () => {
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([]);
    const { api, hooks } = createApi({
      localSearchResults: [
        {
          source: "local",
          path: "/tmp/memory/2026-02-26.md",
          snippet: "User asked about Lewis Hamilton updates and F1 race timing.",
          score: 0.99,
        },
      ],
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;
    expect(beforeAgentStart).toBeTypeOf("function");

    const result = await beforeAgentStart!(
      {
        prompt: "Please help me save my hotcake recipe.",
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(result && "prependContext" in result ? result.prependContext : undefined).toBeUndefined();
    expect(result && "systemPrompt" in result ? result.systemPrompt : "").toContain(
      "remember_learning",
    );
  });

  it("skips recall when there is no new user turn in the same session", async () => {
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        source: "mem0",
        snippet: "User prefers afternoon standups.",
        score: 0.8,
      },
    ]);
    const { api, hooks } = createApi({
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;
    expect(beforeAgentStart).toBeTypeOf("function");

    await beforeAgentStart!(
      {
        prompt: "What do I prefer for standups?",
        messages: [
          {
            role: "user",
            content: "Remember that I prefer afternoon standups.",
          },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s1",
      },
    );

    await beforeAgentStart!(
      {
        prompt: "Any relevant memory?",
        messages: [
          {
            role: "user",
            content: "Remember that I prefer afternoon standups.",
          },
          {
            role: "assistant",
            content: "Noted.",
          },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it("skips recall for excluded cron/subagent/acp sessions", async () => {
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        source: "mem0",
        snippet: "User prefers afternoon standups.",
        score: 0.8,
      },
    ]);
    const { api, hooks } = createApi();

    await plugin.register(api as never);
    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;
    expect(beforeAgentStart).toBeTypeOf("function");

    await beforeAgentStart!(
      {
        prompt: "What should I remember?",
        messages: [
          {
            role: "user",
            content: "Remember that I prefer afternoon standups.",
          },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:cron:job-1",
      },
    );

    await beforeAgentStart!(
      {
        prompt: "What should I remember?",
        messages: [
          {
            role: "user",
            content: "Remember that I prefer afternoon standups.",
          },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:subagent:child-1",
      },
    );

    await beforeAgentStart!(
      {
        prompt: "What should I remember?",
        messages: [
          {
            role: "user",
            content: "Remember that I prefer afternoon standups.",
          },
        ],
      },
      {
        workspaceDir: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:acp:worker-1",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(0);
  });

  it("downranks stale low-overlap task memories before merge", async () => {
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        source: "mem0",
        snippet: "Follow up on the drapp reembolso ticket from last year.",
        score: 0.95,
        metadata: { category: "task", indexedAt: "2025-01-01T00:00:00.000Z" },
      },
      {
        source: "mem0",
        snippet: "User prefers afternoon standups for planning.",
        score: 0.72,
        metadata: { category: "preference", indexedAt: "2026-02-20T00:00:00.000Z", sessionKey: "s1" },
      },
    ]);
    const { api, tools } = createApi({
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const boundTools = getBoundTools(tools, {
      config: api.config,
      workspaceDir: "/tmp",
      agentId: "main",
      sessionKey: "s1",
    });
    const searchTool = boundTools.find((tool) => tool.name === "memory_search");
    expect(searchTool).toBeTruthy();

    const output = await searchTool!.execute("call-1", {
      query: "standups preference planning",
    });
    const details = (output as { details?: { results?: Array<{ snippet?: string }> } }).details;
    const snippets = (details?.results ?? []).map((entry) => entry.snippet ?? "");

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(snippets[0]).toContain("afternoon standups");
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
    expect(commandResult.text).toContain("consolidationRuns:");

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

    const boundTools = getBoundTools(tools, {
      config: api.config,
      workspaceDir,
      agentId: "main",
      sessionKey: "s1",
    });
    const searchTool = boundTools.find((tool) => tool.name === "memory_search");
    expect(searchTool).toBeTruthy();

    await searchTool!.execute("call-1", { query: "standups" });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(2);
    lifecycle = await readLifecycleState(createStatePaths(stateDir));
    expect(lifecycle.entries["m-1"]?.recallCount).toBe(1);
    expect(lifecycle.entries["m-1"]?.lastRecalledAt).toBeTypeOf("number");
  });

  it("skips capture when there is no new user turn in the same session", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
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
          {
            role: "assistant",
            content: "Noted.",
          },
        ],
      },
      {
        workspaceDir: path.join(tempDir, "workspace"),
        agentId: "main",
        sessionKey: "s1",
      },
    );

    await agentEndHook!(
      {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember that my timezone is PST and I prefer afternoon standups.",
          },
          {
            role: "assistant",
            content: "Noted.",
          },
          {
            role: "assistant",
            content: "One more internal tool follow-up.",
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
  });

  it("limits assistant-derived agent learnings with cooldown and max writes", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([]);
    const { api, hooks } = createApi({
      stateDir,
      pluginConfig: {
        capture: {
          includeAssistant: true,
          assistant: {
            autoCapture: true,
            minUtilityScore: 0.4,
            cooldownMinutes: 30,
            maxWritesPerSessionWindow: 1,
            maxItemsPerRun: 1,
          },
        },
      },
    });

    await plugin.register(api as never);
    const beforeWrite = hooks.find((entry) => entry.name === "before_message_write")?.handler as
      | ((event: unknown) => Promise<void>)
      | undefined;
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;

    await beforeWrite?.({
      agentId: "main",
      sessionKey: "s1",
      message: {
        role: "user",
        provenance: { kind: "external_user" },
        content: [{ type: "text", text: "first short note" }],
      },
    });
    await agentEndHook?.(
      {
        success: true,
        messages: [
          { role: "user", content: "first short note" },
          {
            role: "assistant",
            content:
              "Remember that I prefer strict lexical overlap gating before semantic dedupe to reduce redundant similarity calls.",
          },
        ],
      },
      {
        workspaceDir: path.join(tempDir, "workspace"),
        agentId: "main",
        sessionKey: "s1",
      },
    );

    await beforeWrite?.({
      agentId: "main",
      sessionKey: "s1",
      message: {
        role: "user",
        provenance: { kind: "external_user" },
        content: [{ type: "text", text: "second short note" }],
      },
    });
    await agentEndHook?.(
      {
        success: true,
        messages: [
          { role: "user", content: "second short note" },
          {
            role: "assistant",
            content:
              "Remember that I prefer strict lexical overlap gating before semantic dedupe to reduce redundant similarity calls.",
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
    const stats = await readStatsState(createStatePaths(stateDir));
    expect(stats.capture.agentLearningAutoCaptured).toBe(1);
    expect(stats.capture.agentLearningRejectedCooldown).toBe(1);
  });

  it("skips capture for excluded cron/subagent/acp sessions", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "m-1" });
    const { api, hooks } = createApi({ stateDir });

    await plugin.register(api as never);
    const agentEndHook = hooks.find((entry) => entry.name === "agent_end")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<void>)
      | undefined;
    expect(agentEndHook).toBeTypeOf("function");

    for (const sessionKey of [
      "agent:main:cron:job-1",
      "agent:main:subagent:child-1",
      "agent:main:acp:worker-1",
    ]) {
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
          sessionKey,
        },
      );
    }

    expect(addSpy).toHaveBeenCalledTimes(0);
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

  it("audits legacy captured memories and reports missing provenance", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    vi.spyOn(Mem0Adapter.prototype, "getAllMemories").mockResolvedValue([
      {
        id: "legacy-1",
        source: "mem0",
        snippet: "Remember that I prefer black coffee in the morning.",
        score: 0.9,
        metadata: { sourceType: "capture" },
      },
      {
        id: "clean-1",
        source: "mem0",
        snippet: "Remember that I prefer afternoon standups.",
        score: 0.8,
        metadata: {
          sourceType: "capture",
          captureOrigin: "external_user",
          capturePath: "before_message_write",
          pluginCaptureVersion: "2026-03-provenance-v1",
        },
      },
    ]);
    const { api, commands } = createApi({ stateDir });

    await plugin.register(api as never);
    const command = commands.find((entry) => entry.name === "memorybraid");
    const result = (await command?.handler({
      args: "audit",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/memorybraid audit",
      config: api.config,
    })) as { text?: string };

    expect(result.text).toContain("Memory Braid remediation audit");
    expect(result.text).toContain("legacy_capture_missing_provenance");
    expect(result.text).toContain("suspicious: 1");
  });

  it("quarantines suspicious memories and excludes them from later injection", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    const getAllSpy = vi.spyOn(Mem0Adapter.prototype, "getAllMemories").mockResolvedValue([
      {
        id: "legacy-1",
        source: "mem0",
        snippet:
          "User: I prefer black coffee.\nAssistant: Noted.\nUser: Deploy every Friday afternoon.",
        score: 0.9,
        metadata: { sourceType: "capture" },
      },
    ]);
    const updateSpy = vi.spyOn(Mem0Adapter.prototype, "updateMemoryMetadata").mockResolvedValue(true);
    const searchSpy = vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        id: "legacy-1",
        source: "mem0",
        snippet:
          "User: I prefer black coffee.\nAssistant: Noted.\nUser: Deploy every Friday afternoon.",
        score: 0.9,
        metadata: { sourceType: "capture" },
      },
    ]);
    const { api, commands, hooks } = createApi({
      stateDir,
      pluginConfig: {
        dedupe: {
          semantic: {
            enabled: false,
          },
        },
      },
    });

    await plugin.register(api as never);
    const command = commands.find((entry) => entry.name === "memorybraid");
    await command?.handler({
      args: "remediate quarantine --apply",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/memorybraid remediate quarantine --apply",
      config: api.config,
    });

    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const remediation = await readRemediationState(createStatePaths(stateDir));
    expect(remediation.quarantined["legacy-1"]).toBeTruthy();

    const beforeAgentStart = hooks.find((entry) => entry.name === "before_agent_start")?.handler as
      | ((event: unknown, ctx: unknown) => Promise<{ prependContext?: string } | void>)
      | undefined;
    const result = await beforeAgentStart?.(
      {
        prompt: "What do I prefer to drink?",
      },
      {
        workspaceDir: path.join(tempDir, "workspace"),
        agentId: "main",
        sessionKey: "s1",
      },
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(result && "prependContext" in result ? result.prependContext : undefined).toBeUndefined();
  });

  it("purges only plugin-captured memories during remediation delete", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    vi.spyOn(Mem0Adapter.prototype, "getAllMemories").mockResolvedValue([
      {
        id: "capture-1",
        source: "mem0",
        snippet: "Remember that I prefer black coffee.",
        score: 0.9,
        metadata: { sourceType: "capture" },
      },
      {
        id: "other-1",
        source: "mem0",
        snippet: "Non-capture memory should survive.",
        score: 0.8,
        metadata: { sourceType: "session" },
      },
    ]);
    const deleteSpy = vi.spyOn(Mem0Adapter.prototype, "deleteMemory").mockResolvedValue(true);
    const { api, commands } = createApi({ stateDir });

    await plugin.register(api as never);
    const command = commands.find((entry) => entry.name === "memorybraid");
    await command?.handler({
      args: "remediate purge-all-captured --apply",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/memorybraid remediate purge-all-captured --apply",
      config: api.config,
    });

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "capture-1",
      }),
    );
  });

  it("searches mem0 audit records via /memorybraid search", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    vi.spyOn(Mem0Adapter.prototype, "searchMemories").mockResolvedValue([
      {
        id: "sem-1",
        source: "mem0",
        snippet: "Preference: Afternoon standups work best for planning.",
        score: 0.93,
        metadata: {
          sourceType: "compendium",
          memoryLayer: "semantic",
          memoryOwner: "user",
          memoryKind: "preference",
          taxonomy: {
            people: [],
            places: [],
            organizations: [],
            projects: [],
            tools: [],
            topics: ["standups"],
          },
          indexedAt: "2026-03-01T12:00:00.000Z",
          firstSeenAt: "2026-02-20T12:00:00.000Z",
          lastSeenAt: "2026-03-01T12:00:00.000Z",
        },
      },
    ]);
    const { api, commands } = createApi({ stateDir });

    await plugin.register(api as never);
    const command = commands.find((entry) => entry.name === "memorybraid");
    const result = (await command?.handler({
      args: "search standups --layer semantic --kind preference",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/memorybraid search standups --layer semantic --kind preference",
      config: api.config,
    })) as { text?: string };

    expect(result.text).toContain("Memory Braid search");
    expect(result.text).toContain("layer: semantic");
    expect(result.text).toContain("kind: preference");
    expect(result.text).toContain("taxonomy=topics=standups");
  });

  it("runs manual consolidation and updates consolidation state", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-index-"));
    const stateDir = path.join(tempDir, "state");
    vi.spyOn(Mem0Adapter.prototype, "getAllMemories").mockResolvedValue([
      {
        id: "ep-1",
        source: "mem0",
        snippet: "Remember that I prefer afternoon standups for planning.",
        score: 0.81,
        metadata: {
          sourceType: "capture",
          memoryLayer: "episodic",
          memoryOwner: "user",
          memoryKind: "preference",
          sessionKey: "s1",
          indexedAt: "2026-02-20T12:00:00.000Z",
          firstSeenAt: "2026-02-20T12:00:00.000Z",
          lastSeenAt: "2026-02-20T12:00:00.000Z",
          taxonomy: {
            people: [],
            places: [],
            organizations: [],
            projects: ["Atlas"],
            tools: [],
            topics: ["standups"],
          },
        },
      },
      {
        id: "ep-2",
        source: "mem0",
        snippet: "Remember that afternoon standups are better for planning work.",
        score: 0.79,
        metadata: {
          sourceType: "capture",
          memoryLayer: "episodic",
          memoryOwner: "user",
          memoryKind: "preference",
          sessionKey: "s2",
          indexedAt: "2026-03-01T12:00:00.000Z",
          firstSeenAt: "2026-03-01T12:00:00.000Z",
          lastSeenAt: "2026-03-01T12:00:00.000Z",
          taxonomy: {
            people: [],
            places: [],
            organizations: [],
            projects: ["Atlas"],
            tools: [],
            topics: ["standups"],
          },
        },
      },
    ]);
    await writeLifecycleState(createStatePaths(stateDir), {
      version: 1,
      entries: {
        "ep-1": {
          memoryId: "ep-1",
          contentHash: "h-1",
          workspaceHash: "wh",
          agentId: "main",
          sessionKey: "s1",
          category: "preference",
          createdAt: Date.parse("2026-02-20T12:00:00.000Z"),
          lastCapturedAt: Date.parse("2026-02-20T12:00:00.000Z"),
          lastRecalledAt: Date.parse("2026-03-05T12:00:00.000Z"),
          recallCount: 1,
          updatedAt: Date.parse("2026-03-05T12:00:00.000Z"),
        },
      },
      lastCleanupAt: undefined,
      lastCleanupReason: undefined,
      lastCleanupScanned: undefined,
      lastCleanupExpired: undefined,
      lastCleanupDeleted: undefined,
      lastCleanupFailed: undefined,
    });
    const addSpy = vi.spyOn(Mem0Adapter.prototype, "addMemory").mockResolvedValue({ id: "sem-1" });
    const updateSpy = vi.spyOn(Mem0Adapter.prototype, "updateMemoryMetadata").mockResolvedValue(true);
    const { api, commands } = createApi({ stateDir });

    await plugin.register(api as never);
    const command = commands.find((entry) => entry.name === "memorybraid");
    const result = (await command?.handler({
      args: "consolidate",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/memorybraid consolidate",
      config: api.config,
    })) as { text?: string };

    expect(addSpy).toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalled();
    expect(result.text).toContain("Consolidation complete.");
    expect(result.text).toContain("semanticCreated: 1");

    const consolidation = await readConsolidationState(createStatePaths(stateDir));
    expect(consolidation.lastConsolidationReason).toBe("command");
    expect(consolidation.newEpisodicSinceLastRun).toBe(0);
    expect(Object.keys(consolidation.semanticByCompendiumKey)).toHaveLength(1);
  });
});

import { normalizeForHash } from "./chunking.js";
import type { MemoryBraidConfig } from "./config.js";
import { MemoryBraidLogger } from "./logger.js";
import type { MemoryBraidResult, ScopeKey } from "./types.js";

type CloudRecord = {
  id?: string;
  memory?: string;
  data?: { memory?: string } | null;
  score?: number;
  metadata?: Record<string, unknown> | null;
};

type CloudClientLike = {
  add: (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options?: Record<string, unknown>,
  ) => Promise<CloudRecord[]>;
  search: (query: string, options?: Record<string, unknown>) => Promise<CloudRecord[]>;
  delete: (memoryId: string) => Promise<unknown>;
};

type OssRecord = {
  id?: string;
  memory?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

type OssSearchResult = {
  results?: OssRecord[];
  relations?: unknown[];
};

type OssClientLike = {
  add: (
    messages: string | Array<{ role: string; content: string }>,
    options: Record<string, unknown>,
  ) => Promise<OssSearchResult>;
  search: (query: string, options: Record<string, unknown>) => Promise<OssSearchResult>;
  delete: (memoryId: string) => Promise<{ message: string }>;
};

function extractCloudText(memory: CloudRecord): string {
  const byData = memory.data?.memory;
  if (typeof byData === "string" && byData.trim()) {
    return byData.trim();
  }
  if (typeof memory.memory === "string" && memory.memory.trim()) {
    return memory.memory.trim();
  }
  return "";
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function buildCloudEntity(scope: ScopeKey): { user_id: string; agent_id: string; run_id?: string } {
  const userId = `memory-braid:${scope.workspaceHash}`;
  return {
    user_id: userId,
    agent_id: scope.agentId,
    run_id: scope.sessionKey,
  };
}

function buildOssEntity(scope: ScopeKey): { userId: string; agentId: string; runId?: string } {
  const userId = `memory-braid:${scope.workspaceHash}`;
  return {
    userId,
    agentId: scope.agentId,
    runId: scope.sessionKey,
  };
}

function isLikelyOssConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function buildDefaultOssConfig(cfg: MemoryBraidConfig): Record<string, unknown> {
  const openAiKey = cfg.mem0.apiKey?.trim() || process.env.OPENAI_API_KEY || "";
  return {
    version: "v1.1",
    embedder: {
      provider: "openai",
      config: {
        apiKey: openAiKey,
        model: "text-embedding-3-small",
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: "memories",
        dimension: 1536,
      },
    },
    llm: {
      provider: "openai",
      config: {
        apiKey: openAiKey,
        model: "gpt-4o-mini",
      },
    },
    enableGraph: false,
  };
}

export class Mem0Adapter {
  private cloudClient: CloudClientLike | null = null;
  private ossClient: OssClientLike | null = null;
  private readonly cfg: MemoryBraidConfig;
  private readonly log: MemoryBraidLogger;

  constructor(cfg: MemoryBraidConfig, log: MemoryBraidLogger) {
    this.cfg = cfg;
    this.log = log;
  }

  private async ensureCloudClient(): Promise<CloudClientLike | null> {
    if (this.cloudClient) {
      return this.cloudClient;
    }

    const apiKey = this.cfg.mem0.apiKey?.trim() || process.env.MEM0_API_KEY;
    if (!apiKey) {
      this.log.warn("memory_braid.mem0.error", {
        reason: "api_key_missing",
        mode: "cloud",
      });
      return null;
    }

    try {
      const mod = await import("mem0ai");
      const MemoryClient = mod.MemoryClient ?? mod.default;
      this.cloudClient = new MemoryClient({
        apiKey,
        host: this.cfg.mem0.host,
        organizationId: this.cfg.mem0.organizationId,
        projectId: this.cfg.mem0.projectId,
      }) as CloudClientLike;
      this.log.debug("memory_braid.mem0.response", {
        action: "init",
        mode: "cloud",
        host: this.cfg.mem0.host,
      }, true);
      return this.cloudClient;
    } catch (err) {
      this.log.error("memory_braid.mem0.error", {
        reason: "init_failed",
        mode: "cloud",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async ensureOssClient(): Promise<OssClientLike | null> {
    if (this.ossClient) {
      return this.ossClient;
    }

    try {
      const mod = await import("mem0ai/oss");
      const Memory = (mod as { Memory?: new (config?: Record<string, unknown>) => OssClientLike })
        .Memory;
      if (!Memory) {
        throw new Error("mem0ai/oss Memory export not found");
      }

      const providedConfig = this.cfg.mem0.ossConfig;
      const configToUse = isLikelyOssConfig(providedConfig)
        ? providedConfig
        : buildDefaultOssConfig(this.cfg);

      this.ossClient = new Memory(configToUse);
      this.log.debug("memory_braid.mem0.response", {
        action: "init",
        mode: "oss",
        hasCustomConfig: isLikelyOssConfig(providedConfig),
      }, true);
      return this.ossClient;
    } catch (err) {
      this.log.error("memory_braid.mem0.error", {
        reason: "init_failed",
        mode: "oss",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async ensureClient(): Promise<{ mode: "cloud" | "oss"; client: CloudClientLike | OssClientLike } | null> {
    if (this.cfg.mem0.mode === "oss") {
      const client = await this.ensureOssClient();
      if (!client) {
        return null;
      }
      return { mode: "oss", client };
    }

    const client = await this.ensureCloudClient();
    if (!client) {
      return null;
    }
    return { mode: "cloud", client };
  }

  async addMemory(params: {
    text: string;
    scope: ScopeKey;
    metadata: Record<string, unknown>;
    runId?: string;
  }): Promise<{ id?: string }> {
    const prepared = await this.ensureClient();
    if (!prepared) {
      return {};
    }

    const startedAt = Date.now();
    this.log.debug("memory_braid.mem0.request", {
      runId: params.runId,
      action: "add",
      mode: prepared.mode,
      workspaceHash: params.scope.workspaceHash,
      agentId: params.scope.agentId,
    });

    try {
      if (prepared.mode === "cloud") {
        const entity = buildCloudEntity(params.scope);
        const result = await prepared.client.add(
          [{ role: "user", content: params.text }],
          {
            ...entity,
            metadata: params.metadata,
            infer: true,
          },
        );
        const id = Array.isArray(result) ? result[0]?.id : undefined;
        this.log.debug("memory_braid.mem0.response", {
          runId: params.runId,
          action: "add",
          mode: prepared.mode,
          workspaceHash: params.scope.workspaceHash,
          agentId: params.scope.agentId,
          durMs: Date.now() - startedAt,
          hasId: Boolean(id),
        });
        return { id };
      }

      const entity = buildOssEntity(params.scope);
      const result = await prepared.client.add([{ role: "user", content: params.text }], {
        ...entity,
        metadata: params.metadata,
        infer: true,
      });
      const id = result.results?.[0]?.id;
      this.log.debug("memory_braid.mem0.response", {
        runId: params.runId,
        action: "add",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        hasId: Boolean(id),
      });
      return { id };
    } catch (err) {
      this.log.warn("memory_braid.mem0.error", {
        runId: params.runId,
        action: "add",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  async searchMemories(params: {
    query: string;
    maxResults: number;
    scope: ScopeKey;
    runId?: string;
  }): Promise<MemoryBraidResult[]> {
    const prepared = await this.ensureClient();
    if (!prepared) {
      return [];
    }

    const startedAt = Date.now();
    this.log.debug("memory_braid.mem0.request", {
      runId: params.runId,
      action: "search",
      mode: prepared.mode,
      workspaceHash: params.scope.workspaceHash,
      agentId: params.scope.agentId,
      maxResults: params.maxResults,
    });

    try {
      let mapped: MemoryBraidResult[] = [];
      if (prepared.mode === "cloud") {
        const entity = buildCloudEntity(params.scope);
        const records = await prepared.client.search(params.query, {
          ...entity,
          limit: params.maxResults,
        });

        mapped = records
          .map((record) => {
            const snippet = extractCloudText(record);
            if (!snippet) {
              return null;
            }
            const metadata = normalizeMetadata(record.metadata);
            return {
              id: record.id,
              source: "mem0" as const,
              path: typeof metadata?.path === "string" ? metadata.path : undefined,
              snippet,
              score: typeof record.score === "number" ? record.score : 0,
              metadata,
              chunkKey: typeof metadata?.chunkKey === "string" ? metadata.chunkKey : undefined,
              contentHash:
                typeof metadata?.contentHash === "string" ? metadata.contentHash : undefined,
            };
          })
          .filter((entry): entry is MemoryBraidResult => Boolean(entry));
      } else {
        const entity = buildOssEntity(params.scope);
        const result = await prepared.client.search(params.query, {
          ...entity,
          limit: params.maxResults,
        });
        const records = result.results ?? [];
        mapped = records
          .map((record) => {
            const snippet = typeof record.memory === "string" ? record.memory.trim() : "";
            if (!snippet) {
              return null;
            }
            const metadata = normalizeMetadata(record.metadata);
            return {
              id: record.id,
              source: "mem0" as const,
              path: typeof metadata?.path === "string" ? metadata.path : undefined,
              snippet,
              score: typeof record.score === "number" ? record.score : 0,
              metadata,
              chunkKey: typeof metadata?.chunkKey === "string" ? metadata.chunkKey : undefined,
              contentHash:
                typeof metadata?.contentHash === "string" ? metadata.contentHash : undefined,
            };
          })
          .filter((entry): entry is MemoryBraidResult => Boolean(entry));
      }

      this.log.debug("memory_braid.mem0.response", {
        runId: params.runId,
        action: "search",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        count: mapped.length,
      });

      return mapped;
    } catch (err) {
      this.log.warn("memory_braid.mem0.error", {
        runId: params.runId,
        action: "search",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async deleteMemory(params: {
    memoryId?: string;
    scope: ScopeKey;
    runId?: string;
  }): Promise<boolean> {
    const prepared = await this.ensureClient();
    if (!prepared || !params.memoryId) {
      return false;
    }

    const startedAt = Date.now();
    try {
      await prepared.client.delete(params.memoryId);
      this.log.debug("memory_braid.mem0.response", {
        runId: params.runId,
        action: "delete",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
      });
      return true;
    } catch (err) {
      this.log.warn("memory_braid.mem0.error", {
        runId: params.runId,
        action: "delete",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async semanticSimilarity(params: {
    leftText: string;
    rightText: string;
    scope: ScopeKey;
    runId?: string;
  }): Promise<number | undefined> {
    const rightHash = normalizeForHash(params.rightText);
    const results = await this.searchMemories({
      query: params.leftText,
      maxResults: 5,
      scope: params.scope,
      runId: params.runId,
    });
    for (const result of results) {
      if (normalizeForHash(result.snippet) === rightHash) {
        return result.score;
      }
    }
    return undefined;
  }
}

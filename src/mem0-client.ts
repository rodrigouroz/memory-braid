import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { normalizeForHash, sha256 } from "./chunking.js";
import type { MemoryBraidConfig } from "./config.js";
import { MemoryBraidLogger } from "./logger.js";
import type { MemoryBraidResult, ScopeKey } from "./types.js";

type CloudRecord = {
  id?: string;
  memory?: string;
  data?: { memory?: string } | null;
  score?: number;
  created_at?: string | Date;
  updated_at?: string | Date;
  metadata?: Record<string, unknown> | null;
};

type CloudClientLike = {
  add: (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options?: Record<string, unknown>,
  ) => Promise<CloudRecord[]>;
  get: (memoryId: string) => Promise<CloudRecord>;
  getAll: (options?: Record<string, unknown>) => Promise<CloudRecord[]>;
  search: (query: string, options?: Record<string, unknown>) => Promise<CloudRecord[]>;
  update: (
    memoryId: string,
    data: {
      text?: string;
      metadata?: Record<string, unknown>;
      timestamp?: number | string;
    },
  ) => Promise<CloudRecord[]>;
  delete: (memoryId: string) => Promise<unknown>;
};

type OssRecord = {
  id?: string;
  memory?: string;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
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
  get?: (memoryId: string) => Promise<OssRecord | null>;
  getAll: (options: Record<string, unknown>) => Promise<OssSearchResult>;
  search: (query: string, options: Record<string, unknown>) => Promise<OssSearchResult>;
  update?: (memoryId: string, data: string) => Promise<{ message: string }>;
  updateMemory?: (
    memoryId: string,
    data: string,
    embeddings?: Record<string, number[]>,
    metadata?: Record<string, unknown>,
  ) => Promise<unknown>;
  delete: (memoryId: string) => Promise<{ message: string }>;
};

type OssMemoryCtor = new (config?: Record<string, unknown>) => OssClientLike;

type LoadedOssModule = {
  moduleValue: unknown;
  loader: "require" | "import";
  mem0Path?: string;
  sqlite3Path?: string;
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

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

type ScopeFilter = {
  workspaceHash: string;
  agentId?: string;
  sessionKey?: string;
};

function buildCloudEntity(scope: ScopeFilter): { user_id: string; agent_id?: string; run_id?: string } {
  const userId = `memory-braid:${scope.workspaceHash}`;
  return {
    user_id: userId,
    ...(scope.agentId ? { agent_id: scope.agentId } : {}),
    run_id: scope.sessionKey,
  };
}

function buildOssEntity(scope: ScopeFilter): { userId: string; agentId?: string; runId?: string } {
  const userId = `memory-braid:${scope.workspaceHash}`;
  return {
    userId,
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
    runId: scope.sessionKey,
  };
}

function isLikelyOssConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry));
  }
  if (isObjectLike(value)) {
    return cloneConfigRecord(value);
  }
  return value;
}

function cloneConfigRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = cloneConfigValue(entry);
  }
  return out;
}

function shouldReplaceProviderSection(
  baseValue: Record<string, unknown>,
  overrideValue: Record<string, unknown>,
): boolean {
  const baseProvider = asNonEmptyString(baseValue.provider)?.toLowerCase();
  const overrideProvider = asNonEmptyString(overrideValue.provider)?.toLowerCase();
  return Boolean(baseProvider && overrideProvider && baseProvider !== overrideProvider);
}

function deepMergeConfigRecords(
  baseValue: Record<string, unknown>,
  overrideValue: Record<string, unknown>,
): Record<string, unknown> {
  const merged = cloneConfigRecord(baseValue);
  for (const [key, overrideEntry] of Object.entries(overrideValue)) {
    if (typeof overrideEntry === "undefined") {
      continue;
    }
    const currentBase = merged[key];
    if (isObjectLike(currentBase) && isObjectLike(overrideEntry)) {
      merged[key] = shouldReplaceProviderSection(currentBase, overrideEntry)
        ? cloneConfigRecord(overrideEntry)
        : deepMergeConfigRecords(currentBase, overrideEntry);
      continue;
    }
    merged[key] = cloneConfigValue(overrideEntry);
  }
  return merged;
}

export function mergeOssConfigWithDefaults(
  defaults: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  if (!isLikelyOssConfig(override)) {
    return cloneConfigRecord(defaults);
  }
  return deepMergeConfigRecords(defaults, override);
}

function asOssMemoryCtor(value: unknown): OssMemoryCtor | undefined {
  if (typeof value !== "function") {
    return undefined;
  }
  return value as OssMemoryCtor;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveCtorFromCandidate(candidate: unknown, depth = 0): OssMemoryCtor | undefined {
  if (depth > 6 || !candidate) {
    return undefined;
  }

  const direct = asOssMemoryCtor(candidate);
  if (direct) {
    return direct;
  }

  if (!isObjectLike(candidate)) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  return (
    resolveCtorFromCandidate(record.Memory, depth + 1) ??
    resolveCtorFromCandidate(record.MemoryClient, depth + 1) ??
    resolveCtorFromCandidate(record.default, depth + 1)
  );
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isSqliteBindingsError(error: unknown): boolean {
  const message = asErrorMessage(error);
  return /Could not locate the bindings file/i.test(message) || /node_sqlite3\.node/i.test(message);
}

export function isMem0DeleteNotFoundError(error: unknown): boolean {
  const message = asErrorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }

  return (
    /\bmemory\b.*\bnot found\b/.test(message) ||
    /\bnot found\b.*\bmemory\b/.test(message) ||
    /\bmemory\b.*\bdoes not exist\b/.test(message) ||
    /\bno such memory\b/.test(message)
  );
}

function createLocalRequire(): NodeJS.Require {
  return createRequire(import.meta.url);
}

function tryResolve(requireFn: NodeJS.Require, id: string): string | undefined {
  try {
    return requireFn.resolve(id);
  } catch {
    return undefined;
  }
}

function tryRequire(requireFn: NodeJS.Require, id: string): unknown {
  return requireFn(id);
}

export function resolveOssMemoryCtor(moduleValue: unknown): OssMemoryCtor | undefined {
  return (
    resolveCtorFromCandidate(moduleValue) ??
    resolveCtorFromCandidate(asRecord(moduleValue).Memory) ??
    resolveCtorFromCandidate(asRecord(moduleValue).MemoryClient) ??
    resolveCtorFromCandidate(asRecord(moduleValue).default)
  );
}

function resolveStateDir(explicitStateDir?: string): string {
  const resolved =
    explicitStateDir?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw");
  return path.resolve(resolved);
}

function mapCloudRecord(record: CloudRecord): MemoryBraidResult | null {
  const snippet = extractCloudText(record);
  if (!snippet) {
    return null;
  }
  const metadata = normalizeMetadata(record.metadata);
  return {
    id: record.id,
    source: "mem0",
    path: typeof metadata?.path === "string" ? metadata.path : undefined,
    snippet,
    score: typeof record.score === "number" ? record.score : 0,
    metadata: {
      ...(metadata ?? {}),
      ...(normalizeTimestamp(record.created_at) ? { createdAt: normalizeTimestamp(record.created_at) } : {}),
      ...(normalizeTimestamp(record.updated_at) ? { updatedAt: normalizeTimestamp(record.updated_at) } : {}),
    },
    chunkKey: typeof metadata?.chunkKey === "string" ? metadata.chunkKey : undefined,
    contentHash:
      typeof metadata?.contentHash === "string" ? metadata.contentHash : undefined,
  };
}

function mapOssRecord(record: OssRecord): MemoryBraidResult | null {
  const snippet = typeof record.memory === "string" ? record.memory.trim() : "";
  if (!snippet) {
    return null;
  }
  const metadata = normalizeMetadata(record.metadata);
  return {
    id: record.id,
    source: "mem0",
    path: typeof metadata?.path === "string" ? metadata.path : undefined,
    snippet,
    score: typeof record.score === "number" ? record.score : 0,
    metadata: {
      ...(metadata ?? {}),
      ...(normalizeTimestamp(record.createdAt) ? { createdAt: normalizeTimestamp(record.createdAt) } : {}),
      ...(normalizeTimestamp(record.updatedAt) ? { updatedAt: normalizeTimestamp(record.updatedAt) } : {}),
    },
    chunkKey: typeof metadata?.chunkKey === "string" ? metadata.chunkKey : undefined,
    contentHash:
      typeof metadata?.contentHash === "string" ? metadata.contentHash : undefined,
  };
}

export function resolveDefaultOssStoragePaths(stateDir?: string): {
  rootDir: string;
  historyDbPath: string;
  vectorDbPath: string;
} {
  const rootDir = path.join(resolveStateDir(stateDir), "memory-braid");
  return {
    rootDir,
    historyDbPath: path.join(rootDir, "mem0-history.db"),
    vectorDbPath: path.join(rootDir, "mem0-vector-store.db"),
  };
}

export function applyOssStorageDefaults(
  source: Record<string, unknown>,
  stateDir?: string,
): Record<string, unknown> {
  const { historyDbPath, vectorDbPath } = resolveDefaultOssStoragePaths(stateDir);
  const merged: Record<string, unknown> = { ...source };

  if (!asNonEmptyString(merged.historyDbPath)) {
    merged.historyDbPath = historyDbPath;
  }

  const vectorStore = asRecord(merged.vectorStore);
  const vectorProvider = asNonEmptyString(vectorStore.provider)?.toLowerCase();
  if (!vectorProvider) {
    merged.vectorStore = {
      provider: "memory",
      config: {
        collectionName: "memories",
        dimension: 1536,
        dbPath: vectorDbPath,
      },
    };
  } else if (vectorProvider === "memory") {
    const vectorConfig = asRecord(vectorStore.config);
    if (!asNonEmptyString(vectorConfig.dbPath)) {
      merged.vectorStore = {
        ...vectorStore,
        config: {
          ...vectorConfig,
          dbPath: vectorDbPath,
        },
      };
    }
  }

  const historyStore = asRecord(merged.historyStore);
  const historyProvider = asNonEmptyString(historyStore.provider)?.toLowerCase();
  if (!historyProvider) {
    merged.historyStore = {
      provider: "sqlite",
      config: {
        historyDbPath,
      },
    };
  } else if (historyProvider === "sqlite") {
    const historyConfig = asRecord(historyStore.config);
    if (!asNonEmptyString(historyConfig.historyDbPath)) {
      merged.historyStore = {
        ...historyStore,
        config: {
          ...historyConfig,
          historyDbPath,
        },
      };
    }
  }

  return merged;
}

function collectSqliteDbPaths(config: Record<string, unknown>): string[] {
  const paths: string[] = [];

  const historyStore = asRecord(config.historyStore);
  const historyProvider = asNonEmptyString(historyStore.provider)?.toLowerCase();
  if (historyProvider === "sqlite") {
    const historyPath = asNonEmptyString(asRecord(historyStore.config).historyDbPath);
    if (historyPath && historyPath !== ":memory:") {
      paths.push(historyPath);
    }
  } else {
    const historyPath = asNonEmptyString(config.historyDbPath);
    if (historyPath && historyPath !== ":memory:") {
      paths.push(historyPath);
    }
  }

  const vectorStore = asRecord(config.vectorStore);
  const vectorProvider = asNonEmptyString(vectorStore.provider)?.toLowerCase();
  if (vectorProvider === "memory") {
    const vectorPath = asNonEmptyString(asRecord(vectorStore.config).dbPath);
    if (vectorPath && vectorPath !== ":memory:") {
      paths.push(vectorPath);
    }
  }

  return Array.from(new Set(paths.map((entry) => path.resolve(entry))));
}

async function ensureSqliteParentDirs(config: Record<string, unknown>): Promise<void> {
  for (const dbPath of collectSqliteDbPaths(config)) {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
  }
}

function buildDefaultOssConfig(cfg: MemoryBraidConfig, stateDir?: string): Record<string, unknown> {
  const openAiKey = cfg.mem0.apiKey?.trim() || process.env.OPENAI_API_KEY || "";
  return applyOssStorageDefaults({
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
  }, stateDir);
}

type Mem0AdapterOptions = {
  stateDir?: string;
};

const SEMANTIC_SEARCH_CACHE_TTL_MS = 30_000;
const SEMANTIC_SEARCH_CACHE_MAX_ENTRIES = 256;

export class Mem0Adapter {
  private cloudClient: CloudClientLike | null = null;
  private ossClient: OssClientLike | null = null;
  private readonly cfg: MemoryBraidConfig;
  private readonly log: MemoryBraidLogger;
  private readonly pluginDir?: string;
  private stateDir?: string;
  private readonly semanticSearchCache = new Map<
    string,
    {
      expiresAt: number;
      results: MemoryBraidResult[];
    }
  >();

  constructor(cfg: MemoryBraidConfig, log: MemoryBraidLogger, options?: Mem0AdapterOptions) {
    this.cfg = cfg;
    this.log = log;
    this.pluginDir = this.resolvePluginDir();
    this.stateDir = options?.stateDir;
  }

  setStateDir(stateDir?: string): void {
    const next = stateDir?.trim();
    if (!next || next === this.stateDir) {
      return;
    }
    this.stateDir = next;
    this.ossClient = null;
    this.semanticSearchCache.clear();
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
      const { moduleValue: mod, loader, mem0Path, sqlite3Path } = await this.loadOssModule();
      const Memory = resolveOssMemoryCtor(mod);
      if (!Memory) {
        const exportKeys = Object.keys(asRecord(mod));
        const defaultKeys = Object.keys(asRecord(asRecord(mod).default));
        throw new Error(
          `mem0ai/oss Memory export not found (exports=${exportKeys.join(",") || "none"}; default=${defaultKeys.join(",") || "none"})`,
        );
      }

      const providedConfig = asRecord(this.cfg.mem0.ossConfig);
      const hasCustomConfig = isLikelyOssConfig(providedConfig);
      const defaultConfig = buildDefaultOssConfig(this.cfg, this.stateDir);
      const mergedConfig = mergeOssConfigWithDefaults(defaultConfig, providedConfig);
      const configToUse = applyOssStorageDefaults(mergedConfig, this.stateDir);
      await ensureSqliteParentDirs(configToUse);

      this.ossClient = new Memory(configToUse);
      this.log.debug("memory_braid.mem0.response", {
        action: "init",
        mode: "oss",
        loader,
        mem0Path,
        sqlite3Path,
        hasCustomConfig,
        sqliteDbPaths: collectSqliteDbPaths(configToUse),
      }, true);
      return this.ossClient;
    } catch (err) {
      const sqliteBindingsError = isSqliteBindingsError(err);
      this.log.error("memory_braid.mem0.error", {
        reason: "init_failed",
        mode: "oss",
        sqliteBindingsError,
        ...(sqliteBindingsError ? this.nativeRebuildHint() : {}),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async loadOssModule(): Promise<LoadedOssModule> {
    const requireFromHere = createLocalRequire();
    const sqlite3Path = tryResolve(requireFromHere, "sqlite3");
    if (sqlite3Path) {
      try {
        tryRequire(requireFromHere, sqlite3Path);
      } catch (error) {
        this.log.warn("memory_braid.mem0.error", {
          reason: "sqlite3_preload_failed",
          mode: "oss",
          ...this.nativeRebuildHint(),
          sqlite3Path,
          error: asErrorMessage(error),
        });
      }
    }

    const mem0Path = tryResolve(requireFromHere, "mem0ai/oss");
    if (mem0Path) {
      try {
        const required = tryRequire(requireFromHere, mem0Path);
        return {
          moduleValue: required,
          loader: "require",
          mem0Path,
          sqlite3Path,
        };
      } catch (error) {
        const sqliteBindingsError = isSqliteBindingsError(error);
        this.log.warn("memory_braid.mem0.error", {
          reason: "oss_require_failed",
          mode: "oss",
          mem0Path,
          sqlite3Path,
          sqliteBindingsError,
          ...(sqliteBindingsError ? this.nativeRebuildHint() : {}),
          error: asErrorMessage(error),
        });
      }
    }

    const imported = await import("mem0ai/oss");
    return {
      moduleValue: imported,
      loader: "import",
      mem0Path,
      sqlite3Path,
    };
  }

  private resolvePluginDir(): string | undefined {
    const requireFromHere = createLocalRequire();
    const packageJsonPath = tryResolve(requireFromHere, "../package.json");
    if (!packageJsonPath) {
      return undefined;
    }
    return path.dirname(packageJsonPath);
  }

  private nativeRebuildHint(): {
    pluginDir?: string;
    fixCommand: string;
    why: string;
  } {
    if (this.pluginDir) {
      return {
        pluginDir: this.pluginDir,
        fixCommand: `cd "${this.pluginDir}" && npm rebuild sqlite3 sharp && openclaw gateway restart`,
        why: "OpenClaw plugin installs use --ignore-scripts, so sqlite3/sharp native artifacts may be missing after install/update.",
      };
    }

    return {
      fixCommand: "cd ~/.openclaw/extensions/memory-braid && npm rebuild sqlite3 sharp && openclaw gateway restart",
      why: "OpenClaw plugin installs use --ignore-scripts, so sqlite3/sharp native artifacts may be missing after install/update.",
    };
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
        const client = prepared.client as CloudClientLike;
        const entity = buildCloudEntity(params.scope);
        const result = await client.add(
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

      const client = prepared.client as OssClientLike;
      const entity = buildOssEntity(params.scope);
      const result = await client.add([{ role: "user", content: params.text }], {
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
        const client = prepared.client as CloudClientLike;
        const entity = buildCloudEntity(params.scope);
        const records = await client.search(params.query, {
          ...entity,
          limit: params.maxResults,
        });
        mapped = records
          .map((record) => mapCloudRecord(record))
          .filter((entry): entry is MemoryBraidResult => Boolean(entry));
      } else {
        const client = prepared.client as OssClientLike;
        const entity = buildOssEntity(params.scope);
        const result = await client.search(params.query, {
          ...entity,
          limit: params.maxResults,
        });
        const records = result.results ?? [];
        mapped = records
          .map((record) => mapOssRecord(record))
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

  async getMemory(params: {
    memoryId?: string;
    scope: ScopeFilter;
    runId?: string;
  }): Promise<MemoryBraidResult | undefined> {
    if (!params.memoryId) {
      return undefined;
    }

    const prepared = await this.ensureClient();
    if (!prepared) {
      return undefined;
    }

    const startedAt = Date.now();
    try {
      if (prepared.mode === "cloud") {
        const client = prepared.client as CloudClientLike;
        const record = await client.get(params.memoryId);
        const mapped = mapCloudRecord(record);
        this.log.debug("memory_braid.mem0.response", {
          runId: params.runId,
          action: "get",
          mode: prepared.mode,
          workspaceHash: params.scope.workspaceHash,
          agentId: params.scope.agentId,
          durMs: Date.now() - startedAt,
          found: Boolean(mapped),
        });
        return mapped ?? undefined;
      }

      const client = prepared.client as OssClientLike;
      if (!client.get) {
        return undefined;
      }
      const record = await client.get(params.memoryId);
      const mapped = record ? mapOssRecord(record) : null;
      this.log.debug("memory_braid.mem0.response", {
        runId: params.runId,
        action: "get",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        found: Boolean(mapped),
      });
      return mapped ?? undefined;
    } catch (err) {
      this.log.warn("memory_braid.mem0.error", {
        runId: params.runId,
        action: "get",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async getAllMemories(params: {
    scope: ScopeFilter;
    limit?: number;
    runId?: string;
  }): Promise<MemoryBraidResult[]> {
    const prepared = await this.ensureClient();
    if (!prepared) {
      return [];
    }

    const startedAt = Date.now();
    const limit = Math.max(1, Math.min(2000, Math.round(params.limit ?? 500)));
    try {
      let mapped: MemoryBraidResult[] = [];
      if (prepared.mode === "cloud") {
        const client = prepared.client as CloudClientLike;
        const entity = buildCloudEntity(params.scope);
        const pageSize = Math.min(100, limit);
        const records: CloudRecord[] = [];
        let page = 1;

        while (records.length < limit) {
          const batch = await client.getAll({
            ...entity,
            page,
            page_size: pageSize,
          });
          if (!Array.isArray(batch) || batch.length === 0) {
            break;
          }
          records.push(...batch);
          if (batch.length < pageSize) {
            break;
          }
          page += 1;
        }

        mapped = records
          .slice(0, limit)
          .map((record) => mapCloudRecord(record))
          .filter((entry): entry is MemoryBraidResult => Boolean(entry));
      } else {
        const client = prepared.client as OssClientLike;
        const entity = buildOssEntity(params.scope);
        const result = await client.getAll({
          ...entity,
          limit,
        });
        mapped = (result.results ?? [])
          .map((record) => mapOssRecord(record))
          .filter((entry): entry is MemoryBraidResult => Boolean(entry));
      }

      this.log.debug("memory_braid.mem0.response", {
        runId: params.runId,
        action: "get_all",
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
        action: "get_all",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async updateMemoryMetadata(params: {
    memoryId?: string;
    scope: ScopeFilter;
    text: string;
    metadata: Record<string, unknown>;
    runId?: string;
  }): Promise<boolean> {
    if (!params.memoryId) {
      return false;
    }

    const prepared = await this.ensureClient();
    if (!prepared) {
      return false;
    }

    const startedAt = Date.now();
    try {
      if (prepared.mode === "cloud") {
        const client = prepared.client as CloudClientLike;
        await client.update(params.memoryId, {
          text: params.text,
          metadata: params.metadata,
        });
      } else {
        const client = prepared.client as OssClientLike;
        if (typeof client.updateMemory !== "function") {
          return false;
        }
        await client.updateMemory(params.memoryId, params.text, {}, params.metadata);
      }

      this.log.debug("memory_braid.mem0.response", {
        runId: params.runId,
        action: "update_metadata",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        updated: true,
      });
      return true;
    } catch (err) {
      this.log.warn("memory_braid.mem0.error", {
        runId: params.runId,
        action: "update_metadata",
        mode: prepared.mode,
        workspaceHash: params.scope.workspaceHash,
        agentId: params.scope.agentId,
        durMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
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
      const missingRemote = isMem0DeleteNotFoundError(err);
      if (missingRemote) {
        this.log.debug("memory_braid.mem0.response", {
          runId: params.runId,
          action: "delete",
          mode: prepared.mode,
          workspaceHash: params.scope.workspaceHash,
          agentId: params.scope.agentId,
          memoryId: params.memoryId,
          durMs: Date.now() - startedAt,
          alreadyMissing: true,
        });
        return true;
      }

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
    if (!rightHash) {
      return undefined;
    }

    const leftHash = normalizeForHash(params.leftText);
    if (!leftHash) {
      return undefined;
    }

    const now = Date.now();
    this.pruneSemanticSearchCache(now);
    const scopeSession = params.scope.sessionKey ?? "";
    const cacheKey = `${params.scope.workspaceHash}|${params.scope.agentId}|${scopeSession}|${sha256(leftHash)}`;
    const cached = this.semanticSearchCache.get(cacheKey);
    const results =
      cached && cached.expiresAt > now
        ? cached.results
        : await this.searchMemories({
            query: params.leftText,
            maxResults: 5,
            scope: params.scope,
            runId: params.runId,
          });

    if (!cached || cached.expiresAt <= now) {
      this.semanticSearchCache.set(cacheKey, {
        expiresAt: now + SEMANTIC_SEARCH_CACHE_TTL_MS,
        results,
      });
      this.pruneSemanticSearchCache(now);
    }

    for (const result of results) {
      if (normalizeForHash(result.snippet) === rightHash) {
        return result.score;
      }
    }
    return undefined;
  }

  private pruneSemanticSearchCache(now = Date.now()): void {
    for (const [key, entry] of this.semanticSearchCache.entries()) {
      if (entry.expiresAt <= now) {
        this.semanticSearchCache.delete(key);
      }
    }

    while (this.semanticSearchCache.size > SEMANTIC_SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = this.semanticSearchCache.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.semanticSearchCache.delete(oldest);
    }
  }
}

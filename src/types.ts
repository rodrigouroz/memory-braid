export type MemoryBraidSource = "local" | "mem0";

export type ManagedSourceType = "markdown" | "session";

export type PersistedSourceType = ManagedSourceType | "capture";

export type ScopeKey = {
  workspaceHash: string;
  agentId: string;
  sessionKey?: string;
};

export type TargetWorkspace = {
  workspaceDir: string;
  stateDir: string;
  agentId: string;
  workspaceHash: string;
};

export type MemoryBraidResult = {
  id?: string;
  source: MemoryBraidSource;
  path?: string;
  startLine?: number;
  endLine?: number;
  snippet: string;
  score: number;
  mergedScore?: number;
  metadata?: Record<string, unknown>;
  chunkKey?: string;
  contentHash?: string;
};

export type ManifestChunk = {
  chunkKey: string;
  contentHash: string;
  sourceType: ManagedSourceType;
  text: string;
  path: string;
  workspaceHash: string;
  agentId: string;
  updatedAt: number;
};

export type IndexedEntry = {
  chunkKey: string;
  id?: string;
  contentHash: string;
  sourceType: PersistedSourceType;
  path?: string;
  workspaceHash: string;
  agentId: string;
  updatedAt: number;
  missingCount?: number;
};

export type ReconcileState = {
  version: 1;
  entries: Record<string, IndexedEntry>;
  lastRunAt?: string;
};

export type BootstrapState = {
  version: 1;
  completed: boolean;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  summary?: {
    reason: string;
    total: number;
    upserted: number;
    deleted: number;
    unchanged: number;
  };
};

export type CaptureDedupeState = {
  version: 1;
  seen: Record<string, number>;
};

export type ReconcileSummary = {
  reason: string;
  total: number;
  upserted: number;
  deleted: number;
  unchanged: number;
};

export type ExtractedCandidate = {
  text: string;
  category: "preference" | "decision" | "fact" | "task" | "other";
  score: number;
  source: "heuristic" | "ml";
};

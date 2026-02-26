export type MemoryBraidSource = "local" | "mem0";

export type ScopeKey = {
  workspaceHash: string;
  agentId: string;
  sessionKey?: string;
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

export type CaptureDedupeState = {
  version: 1;
  seen: Record<string, number>;
};

export type LifecycleEntry = {
  memoryId: string;
  contentHash: string;
  workspaceHash: string;
  agentId: string;
  sessionKey?: string;
  category?: string;
  createdAt: number;
  lastCapturedAt: number;
  lastRecalledAt?: number;
  recallCount: number;
  updatedAt: number;
};

export type LifecycleState = {
  version: 1;
  entries: Record<string, LifecycleEntry>;
  lastCleanupAt?: string;
  lastCleanupReason?: "startup" | "interval" | "command";
  lastCleanupScanned?: number;
  lastCleanupExpired?: number;
  lastCleanupDeleted?: number;
  lastCleanupFailed?: number;
};

export type CaptureStats = {
  runs: number;
  runsWithCandidates: number;
  runsNoCandidates: number;
  candidates: number;
  dedupeSkipped: number;
  persisted: number;
  mem0AddAttempts: number;
  mem0AddWithId: number;
  mem0AddWithoutId: number;
  entityAnnotatedCandidates: number;
  totalEntitiesAttached: number;
  lastRunAt?: string;
};

export type PluginStatsState = {
  version: 1;
  capture: CaptureStats;
};

export type ExtractedCandidate = {
  text: string;
  category: "preference" | "decision" | "fact" | "task" | "other";
  score: number;
  source: "heuristic" | "ml";
};

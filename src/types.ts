export type MemoryBraidSource = "local" | "mem0";

export const PLUGIN_CAPTURE_VERSION = "2026-03-provenance-v1";

export type CaptureOrigin = "external_user" | "assistant_derived";

export type CapturePath = "before_message_write" | "agent_end_last_turn";

export type MemoryOwner = "user" | "agent";

export type MemoryKind =
  | "fact"
  | "preference"
  | "decision"
  | "task"
  | "heuristic"
  | "lesson"
  | "strategy"
  | "other";

export type CaptureIntent = "observed" | "inferred" | "self_reflection" | "explicit_tool";

export type RecallTarget = "response" | "planning" | "both";

export type Stability = "ephemeral" | "session" | "durable";

export type MemoryLayer = "episodic" | "semantic" | "procedural";

export type MemorySelectionDecision = "ignore" | "episodic" | "procedural" | "semantic";

export type TaxonomyBuckets = {
  people: string[];
  places: string[];
  organizations: string[];
  projects: string[];
  tools: string[];
  topics: string[];
};

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
  trustedTurns: number;
  fallbackTurnSlices: number;
  provenanceSkipped: number;
  transcriptShapeSkipped: number;
  quarantinedFiltered: number;
  remediationQuarantined: number;
  remediationDeleted: number;
  agentLearningToolCalls: number;
  agentLearningAccepted: number;
  agentLearningRejectedValidation: number;
  agentLearningRejectedNovelty: number;
  agentLearningRejectedCooldown: number;
  agentLearningAutoCaptured: number;
  agentLearningAutoRejected: number;
  agentLearningInjected: number;
  agentLearningRecallHits: number;
  selectionSkipped: number;
  agentLearningRejectedSelection: number;
  consolidationRuns: number;
  consolidationCandidates: number;
  clustersFormed: number;
  semanticCreated: number;
  semanticUpdated: number;
  episodicMarkedConsolidated: number;
  contradictionsDetected: number;
  supersededMarked: number;
  lastRunAt?: string;
  lastRemediationAt?: string;
  lastConsolidationAt?: string;
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

export type PendingInboundTurn = {
  text: string;
  messageHash: string;
  receivedAt: number;
};

export type CaptureInputMessage = {
  role: "user" | "assistant";
  text: string;
  origin: CaptureOrigin;
  messageHash: string;
};

export type AssembledCaptureInput = {
  messages: CaptureInputMessage[];
  capturePath: CapturePath;
  turnHash: string;
  fallbackUsed: boolean;
};

export type RemediationState = {
  version: 1;
  quarantined: Record<
    string,
    {
      memoryId: string;
      reason: string;
      quarantinedAt: string;
      updatedRemotely?: boolean;
    }
  >;
};

export type ConsolidationReason = "startup" | "interval" | "opportunistic" | "command";

export type ConsolidationState = {
  version: 1;
  lastConsolidationAt?: string;
  lastConsolidationReason?: ConsolidationReason;
  newEpisodicSinceLastRun: number;
  semanticByCompendiumKey: Record<
    string,
    {
      memoryId: string;
      updatedAt: number;
    }
  >;
};

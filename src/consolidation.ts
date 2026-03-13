import { normalizeForHash, sha256 } from "./chunking.js";
import type { MemoryBraidConfig } from "./config.js";
import {
  asRecord,
  asString,
  buildTaxonomy,
  formatTaxonomySummary,
  inferMemoryLayer,
  normalizeMemoryKind,
  normalizeTaxonomy,
  primaryTaxonomyAnchor,
  summarizeClusterText,
  taxonomyOverlap,
  taxonomyTerms,
} from "./memory-model.js";
import { scoreSemanticPromotion } from "./memory-selection.js";
import { resolveResultTimeMs } from "./temporal.js";
import type {
  ConsolidationState,
  LifecycleEntry,
  MemoryBraidResult,
  MemoryKind,
  TaxonomyBuckets,
} from "./types.js";

type Cluster = {
  kind: MemoryKind;
  anchor?: string;
  taxonomy: TaxonomyBuckets;
  memories: MemoryBraidResult[];
  firstSeenAt: number;
  lastSeenAt: number;
  recallSupport: number;
  sessionKeys: Set<string>;
};

export type SemanticDraft = {
  compendiumKey: string;
  existingMemoryId?: string;
  text: string;
  metadata: Record<string, unknown>;
  sourceMemories: MemoryBraidResult[];
  latestAt: number;
  kind: MemoryKind;
  anchor?: string;
};

export type SupersedeDraft = {
  memoryId: string;
  text: string;
  metadata: Record<string, unknown>;
};

function tokenize(text: string): Set<string> {
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const token of tokens) {
    const normalized = token
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "");
    if (normalized.length >= 4) {
      out.add(normalized);
    }
  }
  return out;
}

function lexicalSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function resolveKind(memory: MemoryBraidResult): MemoryKind {
  const metadata = asRecord(memory.metadata);
  return normalizeMemoryKind(metadata.memoryKind) ?? "other";
}

function resolveTaxonomy(memory: MemoryBraidResult): TaxonomyBuckets {
  const metadata = asRecord(memory.metadata);
  return buildTaxonomy({
    text: memory.snippet,
    entities: metadata.entities,
    existingTaxonomy: metadata.taxonomy,
  });
}

function resolveAnchor(memory: MemoryBraidResult): string | undefined {
  return primaryTaxonomyAnchor(resolveTaxonomy(memory));
}

function resolveLifecycleRecall(
  memoryId: string | undefined,
  lifecycle: Record<string, LifecycleEntry>,
): number {
  if (!memoryId) {
    return 0;
  }
  const entry = lifecycle[memoryId];
  return entry ? Math.max(0, entry.recallCount ?? 0) : 0;
}

function buildCompendiumKey(params: {
  kind: MemoryKind;
  anchor?: string;
  taxonomy: TaxonomyBuckets;
  text: string;
}): string {
  const signature = [
    params.kind,
    params.anchor ?? "",
    ...taxonomyTerms(params.taxonomy).slice(0, 6).map((value) => normalizeForHash(value)),
    normalizeForHash(params.text),
  ]
    .filter(Boolean)
    .join("|");
  return sha256(signature);
}

async function shouldJoinCluster(params: {
  cluster: Cluster;
  memory: MemoryBraidResult;
  semanticSimilarity?: (leftText: string, rightText: string) => Promise<number | undefined>;
}): Promise<boolean> {
  const memoryTaxonomy = resolveTaxonomy(params.memory);
  const memoryAnchor = primaryTaxonomyAnchor(memoryTaxonomy);
  if (params.cluster.kind !== resolveKind(params.memory)) {
    return false;
  }
  if (params.cluster.anchor && memoryAnchor && params.cluster.anchor === memoryAnchor) {
    return true;
  }
  if (taxonomyOverlap(params.cluster.taxonomy, memoryTaxonomy) >= 0.34) {
    return true;
  }
  const latest = params.cluster.memories[params.cluster.memories.length - 1];
  const lexical = lexicalSimilarity(latest?.snippet ?? "", params.memory.snippet);
  if (lexical >= 0.42) {
    return true;
  }
  if (params.semanticSimilarity) {
    const semantic = await params.semanticSimilarity(latest?.snippet ?? "", params.memory.snippet);
    if (typeof semantic === "number" && semantic >= 0.86) {
      return true;
    }
  }
  return false;
}

export async function buildConsolidationDrafts(params: {
  episodic: MemoryBraidResult[];
  existingSemantic: MemoryBraidResult[];
  lifecycleEntries: Record<string, LifecycleEntry>;
  cfg: MemoryBraidConfig;
  minSupportCount: number;
  minRecallCount: number;
  semanticMaxSourceIds: number;
  state: ConsolidationState;
  semanticSimilarity?: (leftText: string, rightText: string) => Promise<number | undefined>;
}): Promise<{ candidates: number; clustersFormed: number; drafts: SemanticDraft[] }> {
  const episodic = params.episodic
    .filter((memory) => inferMemoryLayer(memory) === "episodic")
    .sort((left, right) => (resolveResultTimeMs(left) ?? 0) - (resolveResultTimeMs(right) ?? 0));
  const clusters: Cluster[] = [];

  for (const memory of episodic) {
    let matched: Cluster | undefined;
    for (const cluster of clusters) {
      if (await shouldJoinCluster({
        cluster,
        memory,
        semanticSimilarity: params.semanticSimilarity,
      })) {
        matched = cluster;
        break;
      }
    }
    const ts = resolveResultTimeMs(memory) ?? Date.now();
    if (!matched) {
      clusters.push({
        kind: resolveKind(memory),
        anchor: resolveAnchor(memory),
        taxonomy: resolveTaxonomy(memory),
        memories: [memory],
        firstSeenAt: ts,
        lastSeenAt: ts,
        recallSupport: resolveLifecycleRecall(memory.id, params.lifecycleEntries),
        sessionKeys: new Set(
          asString(asRecord(memory.metadata).sessionKey)
            ? [asString(asRecord(memory.metadata).sessionKey)!]
            : [],
        ),
      });
      continue;
    }
    matched.memories.push(memory);
    matched.taxonomy = buildTaxonomy({
      text: `${formatTaxonomySummary(matched.taxonomy)} ${memory.snippet}`,
      entities: Array.isArray(asRecord(memory.metadata).entities)
        ? (asRecord(memory.metadata).entities as unknown[])
        : [],
      existingTaxonomy: matched.taxonomy,
    });
    matched.firstSeenAt = Math.min(matched.firstSeenAt, ts);
    matched.lastSeenAt = Math.max(matched.lastSeenAt, ts);
    matched.recallSupport += resolveLifecycleRecall(memory.id, params.lifecycleEntries);
    const sessionKey = asString(asRecord(memory.metadata).sessionKey);
    if (sessionKey) {
      matched.sessionKeys.add(sessionKey);
    }
  }

  const existingByKey = new Map<string, MemoryBraidResult>();
  for (const memory of params.existingSemantic) {
    const metadata = asRecord(memory.metadata);
    const key = asString(metadata.compendiumKey);
    if (key) {
      existingByKey.set(key, memory);
    }
  }
  for (const [key, value] of Object.entries(params.state.semanticByCompendiumKey)) {
    if (!existingByKey.has(key) && value?.memoryId) {
      existingByKey.set(key, {
        id: value.memoryId,
        source: "mem0",
        snippet: "",
        score: 0,
        metadata: { compendiumKey: key, memoryLayer: "semantic", sourceType: "compendium" },
      });
    }
  }

  const drafts: SemanticDraft[] = [];
  for (const cluster of clusters) {
    const supportCount = cluster.memories.length;
    const recallSupport = cluster.recallSupport;
    if (
      supportCount < params.minSupportCount &&
      !(supportCount >= 1 && recallSupport >= params.minRecallCount)
    ) {
      continue;
    }
    if (
      (cluster.kind === "task" || cluster.kind === "other") &&
      supportCount < params.minSupportCount + 1 &&
      recallSupport < params.minRecallCount + 1
    ) {
      continue;
    }
    const texts = cluster.memories.map((memory) => memory.snippet);
    const summary = summarizeClusterText(texts, cluster.kind);
    if (!summary) {
      continue;
    }
    const selection = scoreSemanticPromotion({
      kind: cluster.kind,
      supportCount,
      recallSupport,
      taxonomy: cluster.taxonomy,
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.lastSeenAt,
      sessionKeys: cluster.sessionKeys,
      text: summary,
      cfg: params.cfg,
    });
    if (selection.decision !== "semantic") {
      continue;
    }
    const taxonomy = cluster.taxonomy;
    const compendiumKey = buildCompendiumKey({
      kind: cluster.kind,
      anchor: cluster.anchor,
      taxonomy,
      text: summary,
    });
    const existing = existingByKey.get(compendiumKey);
    const sourceMemoryIds = cluster.memories
      .map((memory) => memory.id)
      .filter((value): value is string => Boolean(value))
      .slice(-params.semanticMaxSourceIds);
    const supportIds = new Set(sourceMemoryIds);
    const metadata: Record<string, unknown> = {
      ...(asRecord(existing?.metadata) ?? {}),
      sourceType: "compendium",
      memoryLayer: "semantic",
      memoryOwner: "user",
      memoryKind: cluster.kind,
      stability: "durable",
      supportCount: Math.max(
        supportIds.size,
        typeof asRecord(existing?.metadata).supportCount === "number"
          ? Math.round(asRecord(existing?.metadata).supportCount as number)
          : 0,
      ),
      sourceMemoryIds,
      firstSeenAt: new Date(cluster.firstSeenAt).toISOString(),
      lastSeenAt: new Date(cluster.lastSeenAt).toISOString(),
      lastConfirmedAt: new Date(cluster.lastSeenAt).toISOString(),
      compendiumKey,
      taxonomy,
      taxonomySummary: formatTaxonomySummary(taxonomy),
      selectionDecision: selection.decision,
      rememberabilityScore: selection.score,
      rememberabilityReasons: selection.reasons,
      promotionScore: selection.score,
      promotionReasons: selection.reasons,
    };
    if (cluster.anchor) {
      metadata.primaryAnchor = cluster.anchor;
    }
    drafts.push({
      compendiumKey,
      existingMemoryId: existing?.id,
      text: summary,
      metadata,
      sourceMemories: cluster.memories,
      latestAt: cluster.lastSeenAt,
      kind: cluster.kind,
      anchor: cluster.anchor,
    });
  }

  return {
    candidates: episodic.length,
    clustersFormed: clusters.length,
    drafts,
  };
}

export async function findSupersededSemanticMemories(params: {
  semanticMemories: MemoryBraidResult[];
  semanticSimilarity?: (leftText: string, rightText: string) => Promise<number | undefined>;
}): Promise<SupersedeDraft[]> {
  const grouped = new Map<string, MemoryBraidResult[]>();
  for (const memory of params.semanticMemories) {
    const metadata = asRecord(memory.metadata);
    const kind = normalizeMemoryKind(metadata.memoryKind);
    if (kind !== "preference" && kind !== "decision") {
      continue;
    }
    const anchor =
      asString(metadata.primaryAnchor) ??
      primaryTaxonomyAnchor(normalizeTaxonomy(metadata.taxonomy));
    if (!anchor || !memory.id) {
      continue;
    }
    const key = `${kind}|${normalizeForHash(anchor)}`;
    const rows = grouped.get(key) ?? [];
    rows.push(memory);
    grouped.set(key, rows);
  }

  const updates: SupersedeDraft[] = [];
  for (const rows of grouped.values()) {
    const ordered = [...rows].sort((left, right) => {
      const rightTs = resolveResultTimeMs(right) ?? 0;
      const leftTs = resolveResultTimeMs(left) ?? 0;
      return rightTs - leftTs;
    });
    const newest = ordered[0];
    if (!newest?.id) {
      continue;
    }
    for (const older of ordered.slice(1)) {
      if (!older.id) {
        continue;
      }
      const lexical = lexicalSimilarity(newest.snippet, older.snippet);
      let semantic = lexical;
      if (params.semanticSimilarity) {
        const compared = await params.semanticSimilarity(newest.snippet, older.snippet);
        if (typeof compared === "number") {
          semantic = compared;
        }
      }
      if (semantic >= 0.72) {
        continue;
      }
      const metadata = {
        ...asRecord(older.metadata),
        supersededBy: newest.id,
        supersededAt: new Date().toISOString(),
      };
      updates.push({
        memoryId: older.id,
        text: older.snippet,
        metadata,
      });
    }
  }

  return updates;
}

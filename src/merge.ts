import { normalizeForHash, sha256 } from "./chunking.js";
import type { MemoryBraidResult } from "./types.js";

export type MergeOptions = {
  rrfK: number;
  localWeight: number;
  mem0Weight: number;
};

function identityKey(item: MemoryBraidResult): string {
  if (item.chunkKey) {
    return `chunk:${item.chunkKey}`;
  }
  const path = item.path ?? "";
  const startLine = item.startLine ?? 0;
  const endLine = item.endLine ?? 0;
  const textHash = sha256(normalizeForHash(item.snippet));
  return `${item.source}|${path}|${startLine}|${endLine}|${textHash}`;
}

export function mergeWithRrf(params: {
  local: MemoryBraidResult[];
  mem0: MemoryBraidResult[];
  options: MergeOptions;
}): MemoryBraidResult[] {
  const table = new Map<string, MemoryBraidResult & { _rrf: number }>();

  params.local.forEach((item, index) => {
    const key = identityKey(item);
    const prev = table.get(key);
    const score = params.options.localWeight / (params.options.rrfK + index + 1);
    if (!prev) {
      table.set(key, { ...item, _rrf: score });
      return;
    }
    prev._rrf += score;
  });

  params.mem0.forEach((item, index) => {
    const key = identityKey(item);
    const prev = table.get(key);
    const score = params.options.mem0Weight / (params.options.rrfK + index + 1);
    if (!prev) {
      table.set(key, { ...item, _rrf: score });
      return;
    }
    prev._rrf += score;
    if (prev.source !== item.source) {
      prev.source = "mem0";
    }
  });

  return Array.from(table.values())
    .sort((a, b) => b._rrf - a._rrf)
    .map((item) => ({ ...item, mergedScore: item._rrf }));
}

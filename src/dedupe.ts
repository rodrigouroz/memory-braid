import { normalizeForHash, sha256 } from "./chunking.js";
import type { MemoryBraidResult } from "./types.js";

export type SemanticCompareFn = (
  left: MemoryBraidResult,
  right: MemoryBraidResult,
) => Promise<number | undefined>;

export type DedupeOptions = {
  lexicalMinJaccard: number;
  semanticEnabled: boolean;
  semanticMinScore: number;
  semanticCompare?: SemanticCompareFn;
};

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export async function stagedDedupe(
  input: MemoryBraidResult[],
  options: DedupeOptions,
): Promise<MemoryBraidResult[]> {
  const out: MemoryBraidResult[] = [];
  const exact = new Set<string>();

  for (const candidate of input) {
    const normalized = normalizeForHash(candidate.snippet);
    if (!normalized) {
      continue;
    }

    const exactKey = sha256(normalized);
    if (exact.has(exactKey)) {
      continue;
    }

    const candidateTokens = tokenize(normalized);
    let duplicate = false;

    for (const chosen of out) {
      const chosenTokens = tokenize(normalizeForHash(chosen.snippet));
      const lexicalScore = jaccard(candidateTokens, chosenTokens);
      if (lexicalScore < options.lexicalMinJaccard) {
        continue;
      }

      if (!options.semanticEnabled) {
        duplicate = true;
        break;
      }

      if (!options.semanticCompare) {
        duplicate = true;
        break;
      }

      const semantic = await options.semanticCompare(candidate, chosen);
      if (typeof semantic !== "number") {
        duplicate = true;
        break;
      }
      if (semantic >= options.semanticMinScore) {
        duplicate = true;
        break;
      }
    }

    if (!duplicate) {
      exact.add(exactKey);
      out.push(candidate);
    }
  }

  return out;
}

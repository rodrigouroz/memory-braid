import { describe, expect, it } from "vitest";
import { stagedDedupe } from "../src/dedupe.js";
import type { MemoryBraidResult } from "../src/types.js";

describe("stagedDedupe", () => {
  it("drops exact duplicates", async () => {
    const items: MemoryBraidResult[] = [
      { source: "local", snippet: "I prefer dark roast coffee", score: 0.9 },
      { source: "mem0", snippet: "I prefer dark roast coffee", score: 0.8 },
      { source: "local", snippet: "Use pnpm for this repo", score: 0.7 },
    ];

    const deduped = await stagedDedupe(items, {
      lexicalMinJaccard: 0.3,
      semanticEnabled: false,
      semanticMinScore: 0.92,
    });

    expect(deduped).toHaveLength(2);
    expect(deduped.map((item) => item.snippet)).toContain("I prefer dark roast coffee");
    expect(deduped.map((item) => item.snippet)).toContain("Use pnpm for this repo");
  });

  it("uses semantic comparator after lexical gate", async () => {
    const items: MemoryBraidResult[] = [
      { source: "local", snippet: "User likes concise answers", score: 0.9 },
      { source: "mem0", snippet: "The user prefers concise replies", score: 0.88 },
      { source: "mem0", snippet: "Deploy every Friday", score: 0.7 },
    ];

    const deduped = await stagedDedupe(items, {
      lexicalMinJaccard: 0.2,
      semanticEnabled: true,
      semanticMinScore: 0.9,
      semanticCompare: async (left, right) => {
        if (left.snippet.includes("concise") && right.snippet.includes("concise")) {
          return 0.95;
        }
        return 0.1;
      },
    });

    expect(deduped).toHaveLength(2);
    expect(deduped.map((item) => item.snippet)).toContain("Deploy every Friday");
  });

  it("keeps candidates when semantic score is unavailable", async () => {
    const items: MemoryBraidResult[] = [
      { source: "local", snippet: "User likes concise answers", score: 0.9 },
      { source: "mem0", snippet: "The user prefers concise replies", score: 0.88 },
    ];

    const deduped = await stagedDedupe(items, {
      lexicalMinJaccard: 0.2,
      semanticEnabled: true,
      semanticMinScore: 0.9,
      semanticCompare: async () => undefined,
    });

    expect(deduped).toHaveLength(2);
  });
});

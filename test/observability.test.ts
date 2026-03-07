import { describe, expect, it } from "vitest";
import {
  appendUsageWindow,
  createUsageSnapshot,
  summarizeUsageWindow,
} from "../src/observability.js";

describe("usage observability", () => {
  it("computes cache ratios and estimated cost for known models", () => {
    const snapshot = createUsageSnapshot({
      provider: "anthropic",
      model: "claude-opus-4-6",
      usage: {
        input: 1000,
        output: 300,
        cacheRead: 500,
        cacheWrite: 400,
      },
    });

    expect(snapshot.promptTokens).toBe(1900);
    expect(snapshot.cacheHitRate).toBeCloseTo(500 / 1900, 6);
    expect(snapshot.cacheWriteRate).toBeCloseTo(400 / 1900, 6);
    expect(snapshot.estimatedCostUsd).toBeTypeOf("number");
    expect(snapshot.costEstimateBasis).toBe("estimated");
  });

  it("falls back to token-only basis for unknown models", () => {
    const snapshot = createUsageSnapshot({
      provider: "custom",
      model: "mystery-1",
      usage: {
        input: 1000,
        output: 200,
      },
    });

    expect(snapshot.estimatedCostUsd).toBeUndefined();
    expect(snapshot.costEstimateBasis).toBe("token_only");
  });

  it("flags rising cache-write and prompt trends over the recent window", () => {
    let history: ReturnType<typeof appendUsageWindow> = [];

    for (let i = 0; i < 5; i += 1) {
      history = appendUsageWindow(history, {
        ...createUsageSnapshot({
          provider: "anthropic",
          model: "claude-opus-4-6",
          usage: {
            input: 4000,
            output: 300,
            cacheRead: 8000,
            cacheWrite: 400,
          },
        }),
        at: i,
        runId: `base-${i}`,
      });
    }

    for (let i = 0; i < 5; i += 1) {
      history = appendUsageWindow(history, {
        ...createUsageSnapshot({
          provider: "anthropic",
          model: "claude-opus-4-6",
          usage: {
            input: 7000,
            output: 500,
            cacheRead: 6000,
            cacheWrite: 3500,
          },
        }),
        at: i + 5,
        runId: `spike-${i}`,
      });
    }

    const summary = summarizeUsageWindow(history);
    expect(summary.trends.cacheWriteRate).toBe("rising");
    expect(summary.trends.promptTokens).toBe("rising");
    expect(summary.alerts).toContain("cache_write_rate_rising");
  });
});

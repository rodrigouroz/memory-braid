import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { emptyTaxonomy } from "../src/memory-model.js";
import {
  scoreObservedMemory,
  scoreProceduralMemory,
  scoreSemanticPromotion,
} from "../src/memory-selection.js";

const cfg = parseConfig({});

describe("memory selection", () => {
  it("routes stable user preferences to episodic memory", () => {
    const result = scoreObservedMemory({
      text: "Remember that I prefer afternoon standups for project Atlas.",
      kind: "preference",
      extractionScore: 0.72,
      taxonomy: {
        ...emptyTaxonomy(),
        projects: ["Atlas"],
        topics: ["standups"],
      },
      source: "heuristic",
      cfg,
    });

    expect(result.decision).toBe("episodic");
    expect(result.score).toBeGreaterThanOrEqual(cfg.capture.selection.minPreferenceDecisionScore);
  });

  it("ignores one-off volatile tasks", () => {
    const result = scoreObservedMemory({
      text: "Todo: send the invoice tomorrow.",
      kind: "task",
      extractionScore: 0.8,
      taxonomy: emptyTaxonomy(),
      source: "heuristic",
      cfg,
    });

    expect(result.decision).toBe("ignore");
  });

  it("routes explicit reusable learnings to procedural memory", () => {
    const result = scoreProceduralMemory({
      text: "Prefer strict lexical gating before semantic dedupe to avoid unnecessary similarity calls.",
      confidence: 0.8,
      captureIntent: "explicit_tool",
      cfg,
    });

    expect(result.decision).toBe("procedural");
    expect(result.score).toBeGreaterThanOrEqual(cfg.capture.selection.minProceduralScore);
  });

  it("rejects temporary procedural notes", () => {
    const result = scoreProceduralMemory({
      text: "Use this workaround today only.",
      confidence: 0.9,
      captureIntent: "self_reflection",
      cfg,
    });

    expect(result.decision).toBe("ignore");
  });

  it("promotes repeated stable evidence to semantic memory", () => {
    const result = scoreSemanticPromotion({
      kind: "preference",
      supportCount: 3,
      recallSupport: 2,
      taxonomy: {
        ...emptyTaxonomy(),
        projects: ["Atlas"],
        topics: ["deploys"],
      },
      firstSeenAt: Date.parse("2026-03-01T00:00:00.000Z"),
      lastSeenAt: Date.parse("2026-03-10T00:00:00.000Z"),
      sessionKeys: new Set(["s1", "s2"]),
      text: "Preference: Friday afternoon deploys for Atlas.",
      cfg,
    });

    expect(result.decision).toBe("semantic");
    expect(result.score).toBeGreaterThanOrEqual(cfg.consolidation.minSelectionScore);
  });

  it("does not promote low-signal task clusters", () => {
    const result = scoreSemanticPromotion({
      kind: "task",
      supportCount: 2,
      recallSupport: 0,
      taxonomy: emptyTaxonomy(),
      firstSeenAt: Date.parse("2026-03-01T00:00:00.000Z"),
      lastSeenAt: Date.parse("2026-03-01T00:00:00.000Z"),
      sessionKeys: new Set(["s1"]),
      text: "Recurring task context: send the invoice tomorrow.",
      cfg,
    });

    expect(result.decision).toBe("ignore");
  });
});

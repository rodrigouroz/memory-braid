import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("defaults capture to user-only extraction", () => {
    const cfg = parseConfig({});
    expect(cfg.capture.includeAssistant).toBe(false);
    expect(cfg.capture.assistant.autoCapture).toBe(false);
    expect(cfg.capture.assistant.explicitTool).toBe(true);
    expect(cfg.recall.user.injectTopK).toBe(5);
    expect(cfg.recall.agent.injectTopK).toBe(2);
    expect(cfg.timeDecay.enabled).toBe(false);
    expect(cfg.lifecycle.enabled).toBe(false);
    expect(cfg.lifecycle.captureTtlDays).toBe(90);
    expect(cfg.lifecycle.cleanupIntervalMinutes).toBe(360);
    expect(cfg.lifecycle.reinforceOnRecall).toBe(true);
    expect(cfg.consolidation.enabled).toBe(true);
    expect(cfg.consolidation.startupRun).toBe(false);
    expect(cfg.consolidation.intervalMinutes).toBe(360);
    expect(cfg.consolidation.minSupportCount).toBe(2);
    expect(cfg.capture.selection.minPreferenceDecisionScore).toBe(0.45);
    expect(cfg.capture.selection.minProceduralScore).toBe(0.58);
    expect(cfg.consolidation.minSelectionScore).toBe(0.56);
    expect(cfg.consolidation.timeQueryParsing).toBe(true);
    expect(cfg.entityExtraction.startup.downloadOnStartup).toBe(false);
  });

  it("keeps oss mode and ossConfig object", () => {
    const cfg = parseConfig({
      mem0: {
        mode: "oss",
        ossConfig: {
          vectorStore: { provider: "memory" },
          llm: { provider: "openai" },
        },
      },
    });

    expect(cfg.mem0.mode).toBe("oss");
    expect(cfg.mem0.ossConfig).toEqual({
      vectorStore: { provider: "memory" },
      llm: { provider: "openai" },
    });
  });

  it("defaults to local when capture.mode is invalid", () => {
    const cfg = parseConfig({
      capture: {
        mode: "something-else",
      },
    });

    expect(cfg.capture.mode).toBe("local");
  });

  it("uses explicit capture.mode and maxItemsPerRun", () => {
    const cfg = parseConfig({
      capture: {
        mode: "ml",
        includeAssistant: true,
        maxItemsPerRun: 12,
        selection: {
          minFactScore: 0.6,
          minProceduralScore: 0.62,
        },
        ml: {
          provider: "openai",
          model: "gpt-4o-mini",
        },
      },
      timeDecay: {
        enabled: true,
      },
      lifecycle: {
        enabled: true,
        captureTtlDays: 30,
        cleanupIntervalMinutes: 120,
        reinforceOnRecall: false,
      },
      consolidation: {
        intervalMinutes: 180,
        minSupportCount: 3,
        minSelectionScore: 0.64,
        semanticMaxSourceIds: 12,
      },
      entityExtraction: {
        enabled: true,
      },
    });

    expect(cfg.capture.mode).toBe("ml");
    expect(cfg.capture.includeAssistant).toBe(true);
    expect(cfg.capture.assistant.autoCapture).toBe(true);
    expect(cfg.capture.maxItemsPerRun).toBe(12);
    expect(cfg.capture.selection.minFactScore).toBe(0.6);
    expect(cfg.capture.selection.minProceduralScore).toBe(0.62);
    expect(cfg.timeDecay.enabled).toBe(true);
    expect(cfg.lifecycle.enabled).toBe(true);
    expect(cfg.lifecycle.captureTtlDays).toBe(30);
    expect(cfg.lifecycle.cleanupIntervalMinutes).toBe(120);
    expect(cfg.lifecycle.reinforceOnRecall).toBe(false);
    expect(cfg.consolidation.intervalMinutes).toBe(180);
    expect(cfg.consolidation.minSupportCount).toBe(3);
    expect(cfg.consolidation.minSelectionScore).toBe(0.64);
    expect(cfg.consolidation.semanticMaxSourceIds).toBe(12);
    expect(cfg.entityExtraction.enabled).toBe(true);
    expect(cfg.entityExtraction.provider).toBe("multilingual_ner");
    expect(cfg.entityExtraction.timeoutMs).toBe(2500);
  });

  it("supports openai entity extraction provider with model fallback", () => {
    const cfg = parseConfig({
      entityExtraction: {
        enabled: true,
        provider: "openai",
      },
    });

    expect(cfg.entityExtraction.enabled).toBe(true);
    expect(cfg.entityExtraction.provider).toBe("openai");
    expect(cfg.entityExtraction.model).toBe("gpt-4o-mini");
    expect(cfg.entityExtraction.timeoutMs).toBe(2500);
  });

  it("forces openai fallback model when local default model leaks into config", () => {
    const cfg = parseConfig({
      entityExtraction: {
        enabled: true,
        provider: "openai",
        model: "Xenova/bert-base-multilingual-cased-ner-hrl",
      },
    });

    expect(cfg.entityExtraction.provider).toBe("openai");
    expect(cfg.entityExtraction.model).toBe("gpt-4o-mini");
  });

  it("supports separated recall and assistant capture config", () => {
    const cfg = parseConfig({
      recall: {
        injectTopK: 4,
        user: {
          injectTopK: 3,
        },
        agent: {
          injectTopK: 1,
          minScore: 0.9,
          onlyPlanning: false,
        },
      },
      capture: {
        assistant: {
          autoCapture: true,
          explicitTool: false,
          maxItemsPerRun: 1,
          minUtilityScore: 0.91,
          minNoveltyScore: 0.93,
          maxWritesPerSessionWindow: 2,
          cooldownMinutes: 9,
        },
      },
    });

    expect(cfg.recall.injectTopK).toBe(4);
    expect(cfg.recall.user.injectTopK).toBe(3);
    expect(cfg.recall.agent.injectTopK).toBe(1);
    expect(cfg.recall.agent.minScore).toBe(0.9);
    expect(cfg.recall.agent.onlyPlanning).toBe(false);
    expect(cfg.capture.assistant.autoCapture).toBe(true);
    expect(cfg.capture.assistant.explicitTool).toBe(false);
    expect(cfg.capture.assistant.maxItemsPerRun).toBe(1);
    expect(cfg.capture.assistant.minUtilityScore).toBe(0.91);
    expect(cfg.capture.assistant.minNoveltyScore).toBe(0.93);
    expect(cfg.capture.assistant.maxWritesPerSessionWindow).toBe(2);
    expect(cfg.capture.assistant.cooldownMinutes).toBe(9);
  });
});

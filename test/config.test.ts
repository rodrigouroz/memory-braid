import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("defaults capture to user-only extraction", () => {
    const cfg = parseConfig({});
    expect(cfg.capture.includeAssistant).toBe(false);
    expect(cfg.timeDecay.enabled).toBe(false);
    expect(cfg.lifecycle.enabled).toBe(false);
    expect(cfg.lifecycle.captureTtlDays).toBe(90);
    expect(cfg.lifecycle.cleanupIntervalMinutes).toBe(360);
    expect(cfg.lifecycle.reinforceOnRecall).toBe(true);
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
      entityExtraction: {
        enabled: true,
      },
    });

    expect(cfg.capture.mode).toBe("ml");
    expect(cfg.capture.includeAssistant).toBe(true);
    expect(cfg.capture.maxItemsPerRun).toBe(12);
    expect(cfg.timeDecay.enabled).toBe(true);
    expect(cfg.lifecycle.enabled).toBe(true);
    expect(cfg.lifecycle.captureTtlDays).toBe(30);
    expect(cfg.lifecycle.cleanupIntervalMinutes).toBe(120);
    expect(cfg.lifecycle.reinforceOnRecall).toBe(false);
    expect(cfg.entityExtraction.enabled).toBe(true);
    expect(cfg.entityExtraction.provider).toBe("multilingual_ner");
  });
});

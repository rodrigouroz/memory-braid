import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
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
        maxItemsPerRun: 12,
        ml: {
          provider: "openai",
          model: "gpt-4o-mini",
        },
      },
      entityExtraction: {
        enabled: true,
      },
    });

    expect(cfg.capture.mode).toBe("ml");
    expect(cfg.capture.maxItemsPerRun).toBe(12);
    expect(cfg.entityExtraction.enabled).toBe(true);
    expect(cfg.entityExtraction.provider).toBe("multilingual_ner");
  });
});

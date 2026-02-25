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
});

import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { extractCandidates } from "../src/extract.js";
import { MemoryBraidLogger } from "../src/logger.js";

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("extractCandidates role filtering", () => {
  const messages = [
    { role: "assistant", content: "Remember that we decided to deploy every Friday afternoon." },
    { role: "user", content: "Remember that I prefer black coffee in the morning." },
  ];

  it("captures user messages only by default", async () => {
    const cfg = parseConfig({
      capture: {
        mode: "local",
      },
    });
    const log = new MemoryBraidLogger(noopLogger, cfg.debug);
    const candidates = await extractCandidates({
      messages,
      cfg,
      log,
    });

    expect(candidates.some((entry) => entry.text.includes("prefer black coffee"))).toBe(true);
    expect(candidates.some((entry) => entry.text.includes("deploy every Friday"))).toBe(false);
  });

  it("includes assistant messages when explicitly enabled", async () => {
    const cfg = parseConfig({
      capture: {
        mode: "local",
        includeAssistant: true,
      },
    });
    const log = new MemoryBraidLogger(noopLogger, cfg.debug);
    const candidates = await extractCandidates({
      messages,
      cfg,
      log,
    });

    expect(candidates.some((entry) => entry.text.includes("prefer black coffee"))).toBe(true);
    expect(candidates.some((entry) => entry.text.includes("deploy every Friday"))).toBe(true);
  });
});

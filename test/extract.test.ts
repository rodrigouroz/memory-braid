import { describe, expect, it, vi } from "vitest";
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

  it("skips imported feed-style user text from heuristic capture", async () => {
    const cfg = parseConfig({
      capture: {
        mode: "local",
      },
    });
    const log = new MemoryBraidLogger(noopLogger, cfg.debug);
    const candidates = await extractCandidates({
      messages: [
        {
          role: "user",
          content:
            "Remember that System: [n8n/rss] Lewis Hamilton wins and market alerts are firing.",
        },
        {
          role: "user",
          content: "Remember that I prefer black coffee in the morning.",
        },
      ],
      cfg,
      log,
    });

    expect(candidates.some((entry) => entry.text.includes("n8n/rss"))).toBe(false);
    expect(candidates.some((entry) => entry.text.includes("prefer black coffee"))).toBe(true);
  });

  it("skips pasted multi-speaker transcripts", async () => {
    const cfg = parseConfig({
      capture: {
        mode: "local",
      },
    });
    const log = new MemoryBraidLogger(noopLogger, cfg.debug);
    const candidates = await extractCandidates({
      messages: [
        {
          role: "user",
          content:
            "User: I prefer black coffee.\nAssistant: Noted.\nUser: Deploy every Friday afternoon.",
        },
      ],
      cfg,
      log,
    });

    expect(candidates).toEqual([]);
  });

  it("skips hybrid ML enrichment when no heuristic candidates are found", async () => {
    const cfg = parseConfig({
      capture: {
        mode: "hybrid",
        ml: {
          provider: "openai",
          model: "gpt-4o-mini",
        },
      },
    });
    const log = new MemoryBraidLogger(noopLogger, cfg.debug);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const candidates = await extractCandidates({
      messages: [
        {
          role: "user",
          content: "short note",
        },
      ],
      cfg,
      log,
    });

    expect(candidates).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

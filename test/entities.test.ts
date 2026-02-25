import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCanonicalEntityUri, EntityExtractionManager, resolveEntityModelCacheDir } from "../src/entities.js";
import { parseConfig } from "../src/config.js";
import { MemoryBraidLogger } from "../src/logger.js";

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("entity extraction helpers", () => {
  it("builds canonical URI with slugified label", () => {
    expect(buildCanonicalEntityUri("organization", "Acme Corp.")).toBe(
      "entity://organization/acme-corp",
    );
    expect(buildCanonicalEntityUri("person", "Jalapeño Núñez")).toBe(
      "entity://person/jalapeno-nunez",
    );
  });

  it("resolves entity model cache dir inside .openclaw/memory-braid", () => {
    const cacheDir = resolveEntityModelCacheDir("/tmp/openclaw-state");
    expect(cacheDir).toBe(
      path.join("/tmp/openclaw-state", "memory-braid", "models", "entity-extraction"),
    );
  });

  it("reports status without loading model", () => {
    const cfg = parseConfig({
      entityExtraction: {
        enabled: true,
      },
    });
    const logger = new MemoryBraidLogger(noopLogger, cfg.debug);
    const manager = new EntityExtractionManager(cfg.entityExtraction, logger, {
      stateDir: "/tmp/openclaw-state",
    });

    const status = manager.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.provider).toBe("multilingual_ner");
    expect(status.cacheDir).toBe(
      path.join("/tmp/openclaw-state", "memory-braid", "models", "entity-extraction"),
    );
  });
});


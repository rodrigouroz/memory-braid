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

  it("merges adjacent multi-word location tokens into one entity", async () => {
    const cfg = parseConfig({
      entityExtraction: {
        enabled: true,
        minScore: 0.5,
      },
    });
    const logger = new MemoryBraidLogger(noopLogger, cfg.debug);
    const manager = new EntityExtractionManager(cfg.entityExtraction, logger);
    (manager as unknown as { ensurePipeline: () => Promise<unknown> }).ensurePipeline = async () =>
      async () => [
        { word: "Buenos", entity_group: "LOC", score: 0.99, start: 10, end: 16 },
        { word: "Aires", entity_group: "LOC", score: 0.97, start: 17, end: 22 },
      ];

    const entities = await manager.extract({
      text: "I live in Buenos Aires.",
      runId: "test-run",
    });

    expect(entities).toEqual([
      {
        text: "Buenos Aires",
        type: "location",
        score: 0.97,
        canonicalUri: "entity://location/buenos-aires",
      },
    ]);
  });

  it("does not merge same-type tokens across punctuation gaps", async () => {
    const cfg = parseConfig({
      entityExtraction: {
        enabled: true,
        minScore: 0.5,
      },
    });
    const logger = new MemoryBraidLogger(noopLogger, cfg.debug);
    const manager = new EntityExtractionManager(cfg.entityExtraction, logger);
    (manager as unknown as { ensurePipeline: () => Promise<unknown> }).ensurePipeline = async () =>
      async () => [
        { word: "Buenos", entity_group: "LOC", score: 0.99, start: 10, end: 16 },
        { word: "Aires", entity_group: "LOC", score: 0.97, start: 17, end: 22 },
        { word: "Argentina", entity_group: "LOC", score: 0.95, start: 24, end: 33 },
      ];

    const entities = await manager.extract({
      text: "I live in Buenos Aires, Argentina.",
      runId: "test-run",
    });

    expect(entities.map((entity) => entity.canonicalUri)).toEqual([
      "entity://location/buenos-aires",
      "entity://location/argentina",
    ]);
  });

  it("prevents noisy long-chain merges while keeping clean multi-word locations", async () => {
    const cfg = parseConfig({
      entityExtraction: {
        enabled: true,
        minScore: 0.5,
      },
    });
    const logger = new MemoryBraidLogger(noopLogger, cfg.debug);
    const manager = new EntityExtractionManager(cfg.entityExtraction, logger);
    (manager as unknown as { ensurePipeline: () => Promise<unknown> }).ensurePipeline = async () =>
      async () => [
        { word: "Go", entity_group: "LOC", score: 0.9, start: 0, end: 2 },
        { word: "rton", entity_group: "LOC", score: 0.9, start: 3, end: 7 },
        { word: "dent", entity_group: "LOC", score: 0.9, start: 8, end: 12 },
        { word: "on", entity_group: "LOC", score: 0.9, start: 13, end: 15 },
        { word: "America", entity_group: "LOC", score: 0.9, start: 16, end: 23 },
        { word: "Buenos", entity_group: "LOC", score: 0.95, start: 25, end: 31 },
        { word: "Aires", entity_group: "LOC", score: 0.93, start: 32, end: 37 },
      ];

    const entities = await manager.extract({
      text: "Go rton dent on America, Buenos Aires.",
      runId: "test-run",
    });

    const uris = entities.map((entity) => entity.canonicalUri);
    expect(uris).toContain("entity://location/buenos-aires");
    expect(uris).not.toContain("entity://location/go-rton-dent-on-america-buenos-aires");
  });
});

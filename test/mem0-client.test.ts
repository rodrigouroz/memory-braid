import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOssStorageDefaults,
  resolveDefaultOssStoragePaths,
  resolveOssMemoryCtor,
} from "../src/mem0-client.js";

describe("mem0 oss storage defaults", () => {
  it("uses .openclaw/memory-braid paths when missing", () => {
    const stateDir = "/tmp/openclaw-state";
    const paths = resolveDefaultOssStoragePaths(stateDir);
    const cfg = applyOssStorageDefaults({}, stateDir);

    expect(cfg.historyDbPath).toBe(paths.historyDbPath);
    expect(cfg.historyStore).toEqual({
      provider: "sqlite",
      config: {
        historyDbPath: paths.historyDbPath,
      },
    });
    expect(cfg.vectorStore).toEqual({
      provider: "memory",
      config: {
        collectionName: "memories",
        dimension: 1536,
        dbPath: paths.vectorDbPath,
      },
    });
  });

  it("fills sqlite and memory paths without overriding explicit values", () => {
    const stateDir = "/tmp/openclaw-state";
    const cfg = applyOssStorageDefaults(
      {
        historyDbPath: "/custom/history.db",
        historyStore: {
          provider: "sqlite",
          config: {
            historyDbPath: "/custom/history-store.db",
          },
        },
        vectorStore: {
          provider: "memory",
          config: {
            collectionName: "custom",
            dbPath: "/custom/vector.db",
          },
        },
      },
      stateDir,
    );

    expect(cfg.historyDbPath).toBe("/custom/history.db");
    expect(cfg.historyStore).toEqual({
      provider: "sqlite",
      config: {
        historyDbPath: "/custom/history-store.db",
      },
    });
    expect(cfg.vectorStore).toEqual({
      provider: "memory",
      config: {
        collectionName: "custom",
        dbPath: "/custom/vector.db",
      },
    });
  });

  it("does not inject memory dbPath for non-memory vector stores", () => {
    const stateDir = "/tmp/openclaw-state";
    const cfg = applyOssStorageDefaults(
      {
        vectorStore: {
          provider: "qdrant",
          config: {
            url: "http://127.0.0.1:6333",
            collectionName: "x",
          },
        },
      },
      stateDir,
    );

    expect(cfg.vectorStore).toEqual({
      provider: "qdrant",
      config: {
        url: "http://127.0.0.1:6333",
        collectionName: "x",
      },
    });
  });

  it("keeps source object immutable", () => {
    const source = {
      vectorStore: {
        provider: "memory",
        config: {
          dimension: 768,
        },
      },
    };
    const original = JSON.parse(JSON.stringify(source));

    const cfg = applyOssStorageDefaults(source, "/tmp/openclaw-state");

    expect(source).toEqual(original);
    const vector = cfg.vectorStore as { config?: { dbPath?: string } };
    expect(vector.config?.dbPath).toBe(path.join("/tmp/openclaw-state", "memory-braid", "mem0-vector-store.db"));
  });
});

describe("mem0 oss export resolution", () => {
  class FakeMemory {}

  it("resolves named Memory export", () => {
    const ctor = resolveOssMemoryCtor({ Memory: FakeMemory });
    expect(ctor).toBe(FakeMemory);
  });

  it("resolves default.Memory export", () => {
    const ctor = resolveOssMemoryCtor({ default: { Memory: FakeMemory } });
    expect(ctor).toBe(FakeMemory);
  });

  it("resolves MemoryClient aliases", () => {
    expect(resolveOssMemoryCtor({ MemoryClient: FakeMemory })).toBe(FakeMemory);
    expect(resolveOssMemoryCtor({ default: { MemoryClient: FakeMemory } })).toBe(FakeMemory);
  });

  it("resolves default export when constructor is default", () => {
    const ctor = resolveOssMemoryCtor({ default: FakeMemory });
    expect(ctor).toBe(FakeMemory);
  });

  it("resolves nested default-wrapped Memory constructor", () => {
    const ctor = resolveOssMemoryCtor({ Memory: { default: FakeMemory } });
    expect(ctor).toBe(FakeMemory);
  });

  it("resolves deeply nested default wrapper shapes", () => {
    const ctor = resolveOssMemoryCtor({ default: { default: { Memory: FakeMemory } } });
    expect(ctor).toBe(FakeMemory);
  });

  it("returns undefined when constructor export is unavailable", () => {
    expect(resolveOssMemoryCtor({})).toBeUndefined();
    expect(resolveOssMemoryCtor({ default: {} })).toBeUndefined();
  });
});

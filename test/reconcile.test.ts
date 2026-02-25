import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { MemoryBraidLogger } from "../src/logger.js";
import { runReconcileOnce } from "../src/reconcile.js";
import { createStatePaths, ensureStateDir, readReconcileState } from "../src/state.js";
import type { ScopeKey } from "../src/types.js";

class FakeMem0 {
  private seq = 0;
  readonly stored = new Map<string, string>();

  async addMemory(params: { text: string }): Promise<{ id?: string }> {
    this.seq += 1;
    const id = `m-${this.seq}`;
    this.stored.set(id, params.text);
    return { id };
  }

  async deleteMemory(params: { memoryId?: string; scope: ScopeKey }): Promise<boolean> {
    if (!params.memoryId) {
      return false;
    }
    this.stored.delete(params.memoryId);
    return true;
  }

  async searchMemories(): Promise<never[]> {
    return [];
  }

  async semanticSimilarity(): Promise<number | undefined> {
    return undefined;
  }
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("runReconcileOnce", () => {
  it("upserts current chunks and deletes stale chunks after grace cycle", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-reconcile-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const stateDir = path.join(tempDir, "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Remember that we use pnpm.\n", "utf8");

    const cfg = parseConfig({});
    const mem0 = new FakeMem0();
    const logger = new MemoryBraidLogger(noopLogger, cfg.debug);
    const statePaths = createStatePaths(stateDir);
    await ensureStateDir(statePaths);

    const targets = [
      {
        workspaceDir,
        stateDir,
        agentId: "main",
        workspaceHash: "ws1",
      },
    ];

    const first = await runReconcileOnce({
      cfg,
      mem0: mem0 as never,
      statePaths,
      log: logger,
      targets,
      reason: "test-first",
    });

    expect(first.upserted).toBeGreaterThan(0);
    const stateAfterFirst = await readReconcileState(statePaths);
    const firstKeys = Object.keys(stateAfterFirst.entries);
    expect(firstKeys.length).toBeGreaterThan(0);

    await fs.unlink(path.join(workspaceDir, "MEMORY.md"));

    const second = await runReconcileOnce({
      cfg,
      mem0: mem0 as never,
      statePaths,
      log: logger,
      targets,
      reason: "test-second",
    });

    expect(second.deleted).toBe(0);

    const third = await runReconcileOnce({
      cfg,
      mem0: mem0 as never,
      statePaths,
      log: logger,
      targets,
      reason: "test-third",
    });

    expect(third.deleted).toBeGreaterThan(0);
  });
});

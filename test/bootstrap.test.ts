import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBootstrapIfNeeded } from "../src/bootstrap.js";
import { parseConfig } from "../src/config.js";
import { MemoryBraidLogger } from "../src/logger.js";
import { createStatePaths, ensureStateDir, readBootstrapState } from "../src/state.js";
import type { ScopeKey } from "../src/types.js";

class FakeMem0 {
  async addMemory(): Promise<{ id?: string }> {
    return { id: "m-1" };
  }

  async deleteMemory(_params: { memoryId?: string; scope: ScopeKey }): Promise<boolean> {
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

describe("runBootstrapIfNeeded", () => {
  it("runs once and marks checkpoint as completed", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-bootstrap-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const stateDir = path.join(tempDir, "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "User likes concise answers", "utf8");

    const cfg = parseConfig({});
    const log = new MemoryBraidLogger(noopLogger, cfg.debug);
    const mem0 = new FakeMem0();
    const statePaths = createStatePaths(stateDir);
    await ensureStateDir(statePaths);

    const first = await runBootstrapIfNeeded({
      cfg,
      mem0: mem0 as never,
      statePaths,
      log,
      targets: [
        {
          workspaceDir,
          stateDir,
          agentId: "main",
          workspaceHash: "ws",
        },
      ],
    });

    expect(first.started).toBe(true);
    expect(first.completed).toBe(true);

    const state = await readBootstrapState(statePaths);
    expect(state.completed).toBe(true);

    const second = await runBootstrapIfNeeded({
      cfg,
      mem0: mem0 as never,
      statePaths,
      log,
      targets: [
        {
          workspaceDir,
          stateDir,
          agentId: "main",
          workspaceHash: "ws",
        },
      ],
    });

    expect(second.started).toBe(false);
    expect(second.completed).toBe(true);
  });
});

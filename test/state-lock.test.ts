import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withStateLock } from "../src/state.js";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("withStateLock", () => {
  it("recovers a stale lock when lock owner pid is not alive", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-lock-"));
    const lockFilePath = path.join(tempDir, "state.v1.lock");
    await fs.writeFile(
      lockFilePath,
      `${JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    let executed = false;
    await withStateLock(
      lockFilePath,
      async () => {
        executed = true;
      },
      { retries: 0 },
    );

    expect(executed).toBe(true);
  });

  it("does not steal a lock held by a live process", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-lock-"));
    const lockFilePath = path.join(tempDir, "state.v1.lock");
    const handle = await fs.open(lockFilePath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    await expect(
      withStateLock(
        lockFilePath,
        async () => undefined,
        {
          retries: 1,
          retryDelayMs: 10,
          staleLockMs: 1,
        },
      ),
    ).rejects.toThrow("lock file already exists");

    await handle.close();
    await fs.unlink(lockFilePath).catch(() => undefined);
  });

  it("recovers a stale legacy lock file by mtime", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-braid-lock-"));
    const lockFilePath = path.join(tempDir, "state.v1.lock");
    await fs.writeFile(lockFilePath, "", "utf8");
    const staleAt = new Date(Date.now() - 120_000);
    await fs.utimes(lockFilePath, staleAt, staleAt);

    let executed = false;
    await withStateLock(
      lockFilePath,
      async () => {
        executed = true;
      },
      {
        retries: 0,
        staleLockMs: 1_000,
      },
    );

    expect(executed).toBe(true);
  });
});

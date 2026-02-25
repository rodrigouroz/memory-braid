import fs from "node:fs/promises";
import path from "node:path";
import type { BootstrapState, CaptureDedupeState, ReconcileState } from "./types.js";

const DEFAULT_BOOTSTRAP: BootstrapState = {
  version: 1,
  completed: false,
};

const DEFAULT_RECONCILE: ReconcileState = {
  version: 1,
  entries: {},
};

const DEFAULT_CAPTURE_DEDUPE: CaptureDedupeState = {
  version: 1,
  seen: {},
};

export type StatePaths = {
  rootDir: string;
  bootstrapFile: string;
  reconcileFile: string;
  captureDedupeFile: string;
  stateLockFile: string;
};

export function createStatePaths(stateDir: string): StatePaths {
  const rootDir = path.join(stateDir, "memory-braid");
  return {
    rootDir,
    bootstrapFile: path.join(rootDir, "bootstrap-checkpoint.v1.json"),
    reconcileFile: path.join(rootDir, "reconcile-state.v1.json"),
    captureDedupeFile: path.join(rootDir, "capture-dedupe.v1.json"),
    stateLockFile: path.join(rootDir, "state.v1.lock"),
  };
}

export async function ensureStateDir(paths: StatePaths): Promise<void> {
  await fs.mkdir(paths.rootDir, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function readBootstrapState(paths: StatePaths): Promise<BootstrapState> {
  const value = await readJsonFile(paths.bootstrapFile, DEFAULT_BOOTSTRAP);
  return { ...DEFAULT_BOOTSTRAP, ...value };
}

export async function writeBootstrapState(paths: StatePaths, state: BootstrapState): Promise<void> {
  await writeJsonFile(paths.bootstrapFile, state);
}

export async function readReconcileState(paths: StatePaths): Promise<ReconcileState> {
  const value = await readJsonFile(paths.reconcileFile, DEFAULT_RECONCILE);
  return {
    version: 1,
    entries: value.entries ?? {},
    lastRunAt: value.lastRunAt,
  };
}

export async function writeReconcileState(paths: StatePaths, state: ReconcileState): Promise<void> {
  await writeJsonFile(paths.reconcileFile, state);
}

export async function readCaptureDedupeState(paths: StatePaths): Promise<CaptureDedupeState> {
  const value = await readJsonFile(paths.captureDedupeFile, DEFAULT_CAPTURE_DEDUPE);
  return {
    version: 1,
    seen: value.seen ?? {},
  };
}

export async function writeCaptureDedupeState(
  paths: StatePaths,
  state: CaptureDedupeState,
): Promise<void> {
  await writeJsonFile(paths.captureDedupeFile, state);
}

export async function withStateLock<T>(
  lockFilePath: string,
  fn: () => Promise<T>,
  options?: { retries?: number; retryDelayMs?: number },
): Promise<T> {
  const retries = options?.retries ?? 12;
  const retryDelayMs = options?.retryDelayMs ?? 150;
  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });

  let handle: fs.FileHandle | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      handle = await fs.open(lockFilePath, "wx");
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST" || attempt >= retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  if (!handle) {
    throw new Error(`Failed to acquire lock for ${lockFilePath}`);
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockFilePath).catch(() => undefined);
  }
}

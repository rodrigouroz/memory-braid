import fs from "node:fs/promises";
import path from "node:path";
import type {
  CaptureDedupeState,
  LifecycleState,
  PluginStatsState,
  RemediationState,
} from "./types.js";

const DEFAULT_CAPTURE_DEDUPE: CaptureDedupeState = {
  version: 1,
  seen: {},
};

const DEFAULT_LIFECYCLE: LifecycleState = {
  version: 1,
  entries: {},
};

const DEFAULT_STATS: PluginStatsState = {
  version: 1,
  capture: {
    runs: 0,
    runsWithCandidates: 0,
    runsNoCandidates: 0,
    candidates: 0,
    dedupeSkipped: 0,
    persisted: 0,
    mem0AddAttempts: 0,
    mem0AddWithId: 0,
    mem0AddWithoutId: 0,
    entityAnnotatedCandidates: 0,
    totalEntitiesAttached: 0,
    trustedTurns: 0,
    fallbackTurnSlices: 0,
    provenanceSkipped: 0,
    transcriptShapeSkipped: 0,
    quarantinedFiltered: 0,
    remediationQuarantined: 0,
    remediationDeleted: 0,
  },
};

const DEFAULT_REMEDIATION: RemediationState = {
  version: 1,
  quarantined: {},
};

export type StatePaths = {
  rootDir: string;
  captureDedupeFile: string;
  lifecycleFile: string;
  statsFile: string;
  remediationFile: string;
  stateLockFile: string;
};

export function createStatePaths(stateDir: string): StatePaths {
  const rootDir = path.join(stateDir, "memory-braid");
  return {
    rootDir,
    captureDedupeFile: path.join(rootDir, "capture-dedupe.v1.json"),
    lifecycleFile: path.join(rootDir, "lifecycle.v1.json"),
    statsFile: path.join(rootDir, "stats.v1.json"),
    remediationFile: path.join(rootDir, "remediation.v1.json"),
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

export async function readCaptureDedupeState(paths: StatePaths): Promise<CaptureDedupeState> {
  const value = await readJsonFile(paths.captureDedupeFile, DEFAULT_CAPTURE_DEDUPE);
  return {
    version: 1,
    seen: { ...(value.seen ?? {}) },
  };
}

export async function writeCaptureDedupeState(
  paths: StatePaths,
  state: CaptureDedupeState,
): Promise<void> {
  await writeJsonFile(paths.captureDedupeFile, state);
}

export async function readLifecycleState(paths: StatePaths): Promise<LifecycleState> {
  const value = await readJsonFile(paths.lifecycleFile, DEFAULT_LIFECYCLE);
  return {
    version: 1,
    entries: { ...(value.entries ?? {}) },
    lastCleanupAt: value.lastCleanupAt,
    lastCleanupReason: value.lastCleanupReason,
    lastCleanupScanned: value.lastCleanupScanned,
    lastCleanupExpired: value.lastCleanupExpired,
    lastCleanupDeleted: value.lastCleanupDeleted,
    lastCleanupFailed: value.lastCleanupFailed,
  };
}

export async function writeLifecycleState(paths: StatePaths, state: LifecycleState): Promise<void> {
  await writeJsonFile(paths.lifecycleFile, state);
}

export async function readStatsState(paths: StatePaths): Promise<PluginStatsState> {
  const value = await readJsonFile(paths.statsFile, DEFAULT_STATS);
  return {
    version: 1,
    capture: {
      ...DEFAULT_STATS.capture,
      ...(value.capture ?? {}),
    },
  };
}

export async function writeStatsState(paths: StatePaths, state: PluginStatsState): Promise<void> {
  await writeJsonFile(paths.statsFile, state);
}

export async function readRemediationState(paths: StatePaths): Promise<RemediationState> {
  const value = await readJsonFile(paths.remediationFile, DEFAULT_REMEDIATION);
  return {
    version: 1,
    quarantined: { ...(value.quarantined ?? {}) },
  };
}

export async function writeRemediationState(
  paths: StatePaths,
  state: RemediationState,
): Promise<void> {
  await writeJsonFile(paths.remediationFile, state);
}

export async function withStateLock<T>(
  lockFilePath: string,
  fn: () => Promise<T>,
  options?: { retries?: number; retryDelayMs?: number; staleLockMs?: number },
): Promise<T> {
  const retries = options?.retries ?? 12;
  const retryDelayMs = options?.retryDelayMs ?? 150;
  const staleLockMs = options?.staleLockMs ?? 30_000;
  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });

  let handle: fs.FileHandle | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      handle = await fs.open(lockFilePath, "wx");
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }
      const recovered = await recoverStaleLock(lockFilePath, staleLockMs);
      if (recovered) {
        attempt -= 1;
        continue;
      }
      if (attempt >= retries) {
        throw new Error(`Failed to acquire lock for ${lockFilePath}: lock file already exists`);
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function recoverStaleLock(lockFilePath: string, staleLockMs: number): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockFilePath);
  } catch {
    return false;
  }

  const ageMs = Date.now() - stat.mtimeMs;

  let raw: string | null = null;
  try {
    raw = await fs.readFile(lockFilePath, "utf8");
  } catch {
    raw = null;
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
        if (isProcessAlive(parsed.pid)) {
          return false;
        }
        await fs.unlink(lockFilePath).catch(() => undefined);
        return true;
      }
    } catch {
      // Legacy lock file format, handled by age-based fallback below.
    }
  }

  if (ageMs < staleLockMs) {
    return false;
  }

  await fs.unlink(lockFilePath).catch(() => undefined);
  return true;
}

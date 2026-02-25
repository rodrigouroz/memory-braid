import type { MemoryBraidConfig } from "./config.js";
import { MemoryBraidLogger } from "./logger.js";
import { Mem0Adapter } from "./mem0-client.js";
import {
  readBootstrapState,
  type StatePaths,
  writeBootstrapState,
} from "./state.js";
import type { TargetWorkspace } from "./types.js";
import { runReconcileOnce } from "./reconcile.js";

export async function runBootstrapIfNeeded(params: {
  cfg: MemoryBraidConfig;
  mem0: Mem0Adapter;
  statePaths: StatePaths;
  log: MemoryBraidLogger;
  targets: TargetWorkspace[];
  runId?: string;
}): Promise<{ started: boolean; completed: boolean }> {
  const runId = params.runId ?? params.log.newRunId();

  if (!params.cfg.bootstrap.enabled) {
    return { started: false, completed: false };
  }

  const existing = await readBootstrapState(params.statePaths);
  if (existing.completed) {
    return { started: false, completed: true };
  }

  params.log.debug("memory_braid.bootstrap.begin", {
    runId,
    targets: params.targets.length,
  }, true);

  await writeBootstrapState(params.statePaths, {
    version: 1,
    completed: false,
    startedAt: new Date().toISOString(),
    lastError: undefined,
  });

  try {
    const summary = await runReconcileOnce({
      cfg: params.cfg,
      mem0: params.mem0,
      statePaths: params.statePaths,
      log: params.log,
      targets: params.targets,
      reason: "bootstrap",
      runId,
      deleteStale: false,
    });

    await writeBootstrapState(params.statePaths, {
      version: 1,
      completed: true,
      startedAt: existing.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      summary,
    });

    params.log.debug("memory_braid.bootstrap.complete", {
      runId,
      ...summary,
    }, true);
    return { started: true, completed: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await writeBootstrapState(params.statePaths, {
      version: 1,
      completed: false,
      startedAt: existing.startedAt ?? new Date().toISOString(),
      lastError: error,
    });
    params.log.warn("memory_braid.bootstrap.error", {
      runId,
      error,
    });
    return { started: true, completed: false };
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { buildMarkdownChunks, buildSessionChunks, sha256 } from "./chunking.js";
import type { MemoryBraidConfig } from "./config.js";
import { MemoryBraidLogger } from "./logger.js";
import { Mem0Adapter } from "./mem0-client.js";
import {
  readReconcileState,
  type StatePaths,
  withStateLock,
  writeReconcileState,
} from "./state.js";
import type { IndexedEntry, ManifestChunk, ReconcileSummary, TargetWorkspace } from "./types.js";

type OpenClawConfigLike = {
  agents?: {
    defaults?: {
      workspace?: string;
    };
    list?: Array<{
      id?: string;
      workspace?: string;
      default?: boolean;
    }>;
  };
};

function normalizeAgentId(value: string | undefined): string {
  const trimmed = (value ?? "main").trim().toLowerCase();
  return trimmed || "main";
}

function resolveWorkspacePath(input: string | undefined, fallback?: string): string | undefined {
  const value = (input ?? "").trim() || (fallback ?? "").trim();
  if (!value) {
    return undefined;
  }
  return path.resolve(value);
}

async function workspaceHashForDir(workspaceDir: string): Promise<string> {
  try {
    const real = await fs.realpath(workspaceDir);
    return sha256(real.toLowerCase());
  } catch {
    return sha256(path.resolve(workspaceDir).toLowerCase());
  }
}

export async function resolveTargets(params: {
  config?: OpenClawConfigLike;
  stateDir: string;
  fallbackWorkspaceDir?: string;
}): Promise<TargetWorkspace[]> {
  const targets: TargetWorkspace[] = [];
  const seen = new Set<string>();

  const fallbackWorkspace = resolveWorkspacePath(
    params.config?.agents?.defaults?.workspace,
    params.fallbackWorkspaceDir,
  );
  if (fallbackWorkspace) {
    const agentId = "main";
    const key = `${agentId}|${fallbackWorkspace}`;
    seen.add(key);
    targets.push({
      workspaceDir: fallbackWorkspace,
      stateDir: params.stateDir,
      agentId,
      workspaceHash: await workspaceHashForDir(fallbackWorkspace),
    });
  }

  for (const entry of params.config?.agents?.list ?? []) {
    const workspace = resolveWorkspacePath(entry.workspace, fallbackWorkspace);
    if (!workspace) {
      continue;
    }
    const agentId = normalizeAgentId(entry.id);
    const key = `${agentId}|${workspace}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push({
      workspaceDir: workspace,
      stateDir: params.stateDir,
      agentId,
      workspaceHash: await workspaceHashForDir(workspace),
    });
  }

  return targets;
}

export async function buildManagedManifest(params: {
  targets: TargetWorkspace[];
  cfg: MemoryBraidConfig;
}): Promise<ManifestChunk[]> {
  const out: ManifestChunk[] = [];
  for (const target of params.targets) {
    if (params.cfg.bootstrap.includeMarkdown) {
      out.push(...(await buildMarkdownChunks(target)));
    }
    if (params.cfg.bootstrap.includeSessions) {
      out.push(...(await buildSessionChunks(target, params.cfg.bootstrap.sessionLookbackDays)));
    }
  }
  return out;
}

export async function runReconcileOnce(params: {
  cfg: MemoryBraidConfig;
  mem0: Mem0Adapter;
  statePaths: StatePaths;
  log: MemoryBraidLogger;
  targets: TargetWorkspace[];
  reason: string;
  runId?: string;
  deleteStale?: boolean;
}): Promise<ReconcileSummary> {
  const runId = params.runId ?? params.log.newRunId();
  const startedAt = Date.now();

  return withStateLock(params.statePaths.stateLockFile, async () => {
    params.log.debug("memory_braid.reconcile.begin", {
      runId,
      reason: params.reason,
      targets: params.targets.length,
    }, true);

    const state = await readReconcileState(params.statePaths);
    const manifest = await buildManagedManifest({
      targets: params.targets,
      cfg: params.cfg,
    });

    const byKey = new Map<string, ManifestChunk>();
    for (const chunk of manifest) {
      byKey.set(chunk.chunkKey, chunk);
    }

    let upserted = 0;
    let deleted = 0;
    let unchanged = 0;
    const now = Date.now();

    // Mark managed entries that are no longer present.
    for (const [chunkKey, entry] of Object.entries(state.entries)) {
      if (entry.sourceType === "capture") {
        continue;
      }
      if (byKey.has(chunkKey)) {
        continue;
      }
      const missingCount = (entry.missingCount ?? 0) + 1;
      const shouldDelete =
        (params.deleteStale ?? params.cfg.reconcile.deleteStale) && missingCount >= 2;
      if (!shouldDelete) {
        state.entries[chunkKey] = {
          ...entry,
          missingCount,
          updatedAt: now,
        };
        continue;
      }

      const deletedRemote = await params.mem0.deleteMemory({
        memoryId: entry.id,
        scope: {
          workspaceHash: entry.workspaceHash,
          agentId: entry.agentId,
        },
        runId,
      });
      if (deletedRemote || !entry.id) {
        delete state.entries[chunkKey];
        deleted += 1;
      } else {
        state.entries[chunkKey] = {
          ...entry,
          missingCount,
          updatedAt: now,
        };
      }
    }

    const allChunks = Array.from(byKey.values());
    const batchSize = Math.max(1, params.cfg.reconcile.batchSize);
    for (let offset = 0; offset < allChunks.length; offset += batchSize) {
      const batch = allChunks.slice(offset, offset + batchSize);
      for (const chunk of batch) {
        const existing = state.entries[chunk.chunkKey];
        if (existing && existing.contentHash === chunk.contentHash && existing.sourceType !== "capture") {
          unchanged += 1;
          state.entries[chunk.chunkKey] = {
            ...existing,
            missingCount: 0,
            updatedAt: now,
          };
          continue;
        }

        if (existing?.id && existing.sourceType !== "capture") {
          await params.mem0.deleteMemory({
            memoryId: existing.id,
            scope: {
              workspaceHash: existing.workspaceHash,
              agentId: existing.agentId,
            },
            runId,
          });
        }

        const metadata = {
          sourceType: chunk.sourceType,
          path: chunk.path,
          workspaceHash: chunk.workspaceHash,
          agentId: chunk.agentId,
          chunkKey: chunk.chunkKey,
          contentHash: chunk.contentHash,
          indexedAt: new Date(now).toISOString(),
        };

        const addResult = await params.mem0.addMemory({
          text: chunk.text,
          scope: {
            workspaceHash: chunk.workspaceHash,
            agentId: chunk.agentId,
          },
          metadata,
          runId,
        });

        const next: IndexedEntry = {
          chunkKey: chunk.chunkKey,
          id: addResult.id ?? existing?.id,
          contentHash: chunk.contentHash,
          sourceType: chunk.sourceType,
          path: chunk.path,
          workspaceHash: chunk.workspaceHash,
          agentId: chunk.agentId,
          updatedAt: now,
          missingCount: 0,
        };
        state.entries[chunk.chunkKey] = next;
        upserted += 1;
      }

      params.log.debug("memory_braid.reconcile.progress", {
        runId,
        reason: params.reason,
        processed: Math.min(offset + batch.length, allChunks.length),
        total: allChunks.length,
      });
    }

    const summary: ReconcileSummary = {
      reason: params.reason,
      total: allChunks.length,
      upserted,
      deleted,
      unchanged,
    };

    state.lastRunAt = new Date(now).toISOString();
    await writeReconcileState(params.statePaths, state);

    params.log.debug("memory_braid.reconcile.complete", {
      runId,
      reason: params.reason,
      ...summary,
      durMs: Date.now() - startedAt,
    }, true);

    return summary;
  });
}

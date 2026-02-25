import os from "node:os";
import path from "node:path";
import { normalizeWhitespace } from "./chunking.js";
import type { MemoryBraidConfig } from "./config.js";
import { MemoryBraidLogger } from "./logger.js";

type NerPipeline = (text: string, options?: Record<string, unknown>) => Promise<unknown>;

type NerRecord = {
  word?: unknown;
  entity_group?: unknown;
  entity?: unknown;
  score?: unknown;
};

export type ExtractedEntity = {
  text: string;
  type: "person" | "organization" | "location" | "misc";
  score: number;
  canonicalUri: string;
};

function resolveStateDir(explicitStateDir?: string): string {
  const resolved =
    explicitStateDir?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw");
  return path.resolve(resolved);
}

export function resolveEntityModelCacheDir(stateDir?: string): string {
  return path.join(resolveStateDir(stateDir), "memory-braid", "models", "entity-extraction");
}

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export function buildCanonicalEntityUri(
  type: ExtractedEntity["type"],
  text: string,
): string {
  return `entity://${type}/${slugify(text)}`;
}

function normalizeEntityType(raw: unknown): ExtractedEntity["type"] {
  const label = typeof raw === "string" ? raw.toUpperCase() : "";
  if (label.includes("PER")) {
    return "person";
  }
  if (label.includes("ORG")) {
    return "organization";
  }
  if (label.includes("LOC") || label.includes("GPE")) {
    return "location";
  }
  return "misc";
}

function normalizeEntityText(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return normalizeWhitespace(raw.replace(/^##/, "").replace(/^▁/, ""));
}

type EntityExtractionOptions = {
  stateDir?: string;
};

export class EntityExtractionManager {
  private readonly cfg: MemoryBraidConfig["entityExtraction"];
  private readonly log: MemoryBraidLogger;
  private stateDir?: string;
  private pipelinePromise: Promise<NerPipeline | null> | null = null;

  constructor(
    cfg: MemoryBraidConfig["entityExtraction"],
    log: MemoryBraidLogger,
    options?: EntityExtractionOptions,
  ) {
    this.cfg = cfg;
    this.log = log;
    this.stateDir = options?.stateDir;
  }

  setStateDir(stateDir?: string): void {
    const next = stateDir?.trim();
    if (!next || next === this.stateDir) {
      return;
    }
    this.stateDir = next;
    this.pipelinePromise = null;
  }

  getStatus(): {
    enabled: boolean;
    provider: MemoryBraidConfig["entityExtraction"]["provider"];
    model: string;
    minScore: number;
    maxEntitiesPerMemory: number;
    cacheDir: string;
  } {
    return {
      enabled: this.cfg.enabled,
      provider: this.cfg.provider,
      model: this.cfg.model,
      minScore: this.cfg.minScore,
      maxEntitiesPerMemory: this.cfg.maxEntitiesPerMemory,
      cacheDir: resolveEntityModelCacheDir(this.stateDir),
    };
  }

  async warmup(params?: {
    runId?: string;
    reason?: string;
    forceReload?: boolean;
    text?: string;
  }): Promise<{
    ok: boolean;
    cacheDir: string;
    model: string;
    entities: number;
    durMs: number;
    error?: string;
  }> {
    const startedAt = Date.now();
    if (!this.cfg.enabled) {
      return {
        ok: false,
        cacheDir: resolveEntityModelCacheDir(this.stateDir),
        model: this.cfg.model,
        entities: 0,
        durMs: Date.now() - startedAt,
        error: "entity_extraction_disabled",
      };
    }

    const pipeline = await this.ensurePipeline(params?.forceReload);
    if (!pipeline) {
      return {
        ok: false,
        cacheDir: resolveEntityModelCacheDir(this.stateDir),
        model: this.cfg.model,
        entities: 0,
        durMs: Date.now() - startedAt,
        error: "model_load_failed",
      };
    }

    try {
      const entities = await this.extractWithPipeline({
        pipeline,
        text: params?.text ?? this.cfg.startup.warmupText,
      });
      this.log.info("memory_braid.entity.warmup", {
        runId: params?.runId,
        reason: params?.reason ?? "manual",
        provider: this.cfg.provider,
        model: this.cfg.model,
        cacheDir: resolveEntityModelCacheDir(this.stateDir),
        entities: entities.length,
        durMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        cacheDir: resolveEntityModelCacheDir(this.stateDir),
        model: this.cfg.model,
        entities: entities.length,
        durMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn("memory_braid.entity.warmup", {
        runId: params?.runId,
        reason: params?.reason ?? "manual",
        provider: this.cfg.provider,
        model: this.cfg.model,
        cacheDir: resolveEntityModelCacheDir(this.stateDir),
        error: message,
      });
      return {
        ok: false,
        cacheDir: resolveEntityModelCacheDir(this.stateDir),
        model: this.cfg.model,
        entities: 0,
        durMs: Date.now() - startedAt,
        error: message,
      };
    }
  }

  async extract(params: { text: string; runId?: string }): Promise<ExtractedEntity[]> {
    if (!this.cfg.enabled) {
      return [];
    }

    const text = normalizeWhitespace(params.text);
    if (!text) {
      return [];
    }

    const pipeline = await this.ensurePipeline();
    if (!pipeline) {
      return [];
    }

    try {
      const entities = await this.extractWithPipeline({ pipeline, text });
      this.log.debug("memory_braid.entity.extract", {
        runId: params.runId,
        provider: this.cfg.provider,
        model: this.cfg.model,
        entities: entities.length,
      });
      return entities;
    } catch (err) {
      this.log.warn("memory_braid.entity.extract", {
        runId: params.runId,
        provider: this.cfg.provider,
        model: this.cfg.model,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async ensurePipeline(forceReload = false): Promise<NerPipeline | null> {
    if (!this.cfg.enabled) {
      return null;
    }

    if (forceReload) {
      this.pipelinePromise = null;
    }

    if (this.pipelinePromise) {
      return this.pipelinePromise;
    }

    this.pipelinePromise = this.loadPipeline();
    return this.pipelinePromise;
  }

  private async loadPipeline(): Promise<NerPipeline | null> {
    const cacheDir = resolveEntityModelCacheDir(this.stateDir);
    this.log.info("memory_braid.entity.model_load", {
      provider: this.cfg.provider,
      model: this.cfg.model,
      cacheDir,
    });

    try {
      const mod = (await import("@xenova/transformers")) as {
        env?: Record<string, unknown>;
        pipeline?: (
          task: string,
          model: string,
          options?: Record<string, unknown>,
        ) => Promise<unknown>;
      };

      if (!mod.pipeline) {
        throw new Error("@xenova/transformers pipeline export not found");
      }

      if (mod.env) {
        mod.env.cacheDir = cacheDir;
        mod.env.allowRemoteModels = true;
        mod.env.allowLocalModels = true;
        mod.env.useFS = true;
      }

      const classifier = await mod.pipeline("token-classification", this.cfg.model, {
        quantized: true,
      });

      if (typeof classifier !== "function") {
        throw new Error("token-classification pipeline is not callable");
      }

      return classifier as NerPipeline;
    } catch (err) {
      this.log.error("memory_braid.entity.model_load", {
        provider: this.cfg.provider,
        model: this.cfg.model,
        cacheDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async extractWithPipeline(params: {
    pipeline: NerPipeline;
    text: string;
  }): Promise<ExtractedEntity[]> {
    const raw = await params.pipeline(params.text, {
      aggregation_strategy: "simple",
    });
    const rows = Array.isArray(raw) ? raw : [];

    const deduped = new Map<string, ExtractedEntity>();
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const record = row as NerRecord;
      const entityText = normalizeEntityText(record.word);
      if (!entityText) {
        continue;
      }
      const score = typeof record.score === "number" ? Math.max(0, Math.min(1, record.score)) : 0;
      if (score < this.cfg.minScore) {
        continue;
      }

      const type = normalizeEntityType(record.entity_group ?? record.entity);
      const canonicalUri = buildCanonicalEntityUri(type, entityText);
      const current = deduped.get(canonicalUri);
      if (!current || score > current.score) {
        deduped.set(canonicalUri, {
          text: entityText,
          type,
          score,
          canonicalUri,
        });
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, this.cfg.maxEntitiesPerMemory);
  }
}


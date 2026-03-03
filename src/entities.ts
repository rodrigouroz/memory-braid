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
  start?: unknown;
  end?: unknown;
};

type LlmEntityRecord = {
  text?: unknown;
  type?: unknown;
  label?: unknown;
  entity?: unknown;
  entity_group?: unknown;
  score?: unknown;
};

export type ExtractedEntity = {
  text: string;
  type: "person" | "organization" | "location" | "misc";
  score: number;
  canonicalUri: string;
};

function summarizeEntityTypes(entities: ExtractedEntity[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const entity of entities) {
    summary[entity.type] = (summary[entity.type] ?? 0) + 1;
  }
  return summary;
}

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

function clampScore(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, Math.min(1, fallback));
  }
  return Math.max(0, Math.min(1, value));
}

function parseJsonObjectArray(raw: string): Array<Record<string, unknown>> {
  const attempts = [raw.trim()];

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fencedMatch?.[1]) {
    attempts.push(fencedMatch[1].trim());
  }

  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    attempts.push(raw.slice(firstBracket, lastBracket + 1).trim());
  }

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }
      return parsed.filter((entry) => entry && typeof entry === "object") as Array<
        Record<string, unknown>
      >;
    } catch {
      continue;
    }
  }

  return [];
}

type NormalizedEntityToken = {
  text: string;
  type: ExtractedEntity["type"];
  score: number;
  start?: number;
  end?: number;
};

const ENTITY_CONNECTOR_WORDS = new Set([
  "and",
  "da",
  "de",
  "del",
  "la",
  "las",
  "los",
  "of",
  "the",
  "y",
]);
const ENTITY_MAX_MERGED_WORDS = 3;

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function splitEntityWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isLikelyNoisyShortWord(word: string): boolean {
  const normalized = word.toLowerCase();
  if (normalized.length >= 3) {
    return false;
  }
  if (ENTITY_CONNECTOR_WORDS.has(normalized)) {
    return false;
  }
  return !/^[A-Z]\.?$/.test(word);
}

function joinEntityText(left: NormalizedEntityToken, right: NormalizedEntityToken): string {
  const leftEnd = left.end;
  const rightStart = right.start;
  if (typeof leftEnd === "number" && typeof rightStart === "number") {
    const gap = rightStart - leftEnd;
    if (gap <= 0) {
      return `${left.text}${right.text}`;
    }
  }
  return `${left.text} ${right.text}`;
}

function shouldMergeEntityTokens(
  left: NormalizedEntityToken,
  right: NormalizedEntityToken,
  sourceText?: string,
): boolean {
  if (left.type !== right.type || !left.text || !right.text) {
    return false;
  }

  const leftWords = splitEntityWords(left.text);
  const rightWords = splitEntityWords(right.text);
  if (leftWords.length === 0 || rightWords.length === 0) {
    return false;
  }
  if (leftWords.length + rightWords.length > ENTITY_MAX_MERGED_WORDS) {
    return false;
  }
  const leftLastWord = leftWords[leftWords.length - 1];
  const rightFirstWord = rightWords[0];
  if (!leftLastWord || !rightFirstWord) {
    return false;
  }
  if (isLikelyNoisyShortWord(leftLastWord) || isLikelyNoisyShortWord(rightFirstWord)) {
    return false;
  }

  const leftEnd = left.end;
  const rightStart = right.start;
  if (typeof leftEnd === "number" && typeof rightStart === "number") {
    const gap = rightStart - leftEnd;
    if (gap < 0) {
      return false;
    }
    if (gap > 1) {
      return false;
    }
    if (sourceText && gap > 0) {
      const between = sourceText.slice(leftEnd, rightStart);
      if (between && /[^\s]/u.test(between)) {
        return false;
      }
    }
    return true;
  }

  if (/[.,!?;:]$/.test(left.text) || /^[.,!?;:]/.test(right.text)) {
    return false;
  }
  return true;
}

function collapseAdjacentEntityTokens(
  tokens: NormalizedEntityToken[],
  sourceText?: string,
): NormalizedEntityToken[] {
  if (tokens.length <= 1) {
    return tokens;
  }

  const collapsed: NormalizedEntityToken[] = [];
  for (const token of tokens) {
    const previous = collapsed[collapsed.length - 1];
    if (!previous || !shouldMergeEntityTokens(previous, token, sourceText)) {
      collapsed.push({ ...token });
      continue;
    }

    previous.text = normalizeWhitespace(joinEntityText(previous, token));
    previous.score = Math.min(previous.score, token.score);
    previous.start = typeof previous.start === "number" ? previous.start : token.start;
    previous.end = typeof token.end === "number" ? token.end : previous.end;
  }

  return collapsed;
}

function dedupeAndLimitEntities(
  entities: Array<Omit<ExtractedEntity, "canonicalUri">>,
  maxEntities: number,
): ExtractedEntity[] {
  const deduped = new Map<string, ExtractedEntity>();
  for (const entity of entities) {
    const canonicalUri = buildCanonicalEntityUri(entity.type, entity.text);
    const current = deduped.get(canonicalUri);
    if (!current || entity.score > current.score) {
      deduped.set(canonicalUri, {
        text: entity.text,
        type: entity.type,
        score: entity.score,
        canonicalUri,
      });
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntities);
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
      cacheDir:
        this.cfg.provider === "multilingual_ner"
          ? resolveEntityModelCacheDir(this.stateDir)
          : "n/a",
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
    const cacheDir =
      this.cfg.provider === "multilingual_ner"
        ? resolveEntityModelCacheDir(this.stateDir)
        : "n/a";
    if (!this.cfg.enabled) {
      return {
        ok: false,
        cacheDir,
        model: this.cfg.model,
        entities: 0,
        durMs: Date.now() - startedAt,
        error: "entity_extraction_disabled",
      };
    }

    try {
      const entities = await this.extractWithProvider({
        text: params?.text ?? this.cfg.startup.warmupText,
        forceReload: params?.forceReload,
      });
      this.log.info("memory_braid.entity.warmup", {
        runId: params?.runId,
        reason: params?.reason ?? "manual",
        provider: this.cfg.provider,
        model: this.cfg.model,
        cacheDir,
        entities: entities.length,
        entityTypes: summarizeEntityTypes(entities),
        sampleEntityUris: entities.slice(0, 5).map((entry) => entry.canonicalUri),
        durMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        cacheDir,
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
        cacheDir,
        error: message,
      });
      return {
        ok: false,
        cacheDir,
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

    try {
      const entities = await this.extractWithProvider({ text });
      this.log.debug("memory_braid.entity.extract", {
        runId: params.runId,
        provider: this.cfg.provider,
        model: this.cfg.model,
        entities: entities.length,
        entityTypes: summarizeEntityTypes(entities),
        sampleEntityUris: entities.slice(0, 5).map((entry) => entry.canonicalUri),
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

  private async extractWithProvider(params: {
    text: string;
    forceReload?: boolean;
  }): Promise<ExtractedEntity[]> {
    if (this.cfg.provider === "openai") {
      return this.extractWithOpenAi(params.text);
    }

    const pipeline = await this.ensurePipeline(params.forceReload);
    if (!pipeline) {
      throw new Error("model_load_failed");
    }

    return this.extractWithPipeline({ pipeline, text: params.text });
  }

  private async extractWithOpenAi(text: string): Promise<ExtractedEntity[]> {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
      throw new Error("OPENAI_API_KEY is not set");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const prompt = [
        "Extract named entities from this text.",
        "Return ONLY JSON array.",
        "Each item: {text:string, type:string, score:number}.",
        "type must be one of: person, organization, location, misc.",
        "score must be between 0 and 1.",
        "Do not include duplicates.",
        text,
      ].join("\n");

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "You return strict JSON only.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
      };

      if (!response.ok) {
        throw new Error(data.error?.message ?? `OpenAI HTTP ${response.status}`);
      }

      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = parseJsonObjectArray(content);

      const normalized: Array<Omit<ExtractedEntity, "canonicalUri">> = [];
      for (const row of parsed) {
        const record = row as LlmEntityRecord;
        const entityText = normalizeEntityText(record.text);
        if (!entityText) {
          continue;
        }
        const score = clampScore(record.score, 0.5);
        if (score < this.cfg.minScore) {
          continue;
        }
        const type = normalizeEntityType(
          record.type ?? record.label ?? record.entity_group ?? record.entity,
        );
        normalized.push({
          text: entityText,
          type,
          score,
        });
      }

      return dedupeAndLimitEntities(normalized, this.cfg.maxEntitiesPerMemory);
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensurePipeline(forceReload = false): Promise<NerPipeline | null> {
    if (!this.cfg.enabled) {
      return null;
    }

    if (this.cfg.provider !== "multilingual_ner") {
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

    const normalized: NormalizedEntityToken[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const record = row as NerRecord;
      const entityText = normalizeEntityText(record.word);
      if (!entityText) {
        continue;
      }
      const score = clampScore(record.score);
      if (score < this.cfg.minScore) {
        continue;
      }

      const type = normalizeEntityType(record.entity_group ?? record.entity);
      normalized.push({
        text: entityText,
        type,
        score,
        start: asFiniteNumber(record.start),
        end: asFiniteNumber(record.end),
      });
    }

    const collapsed = collapseAdjacentEntityTokens(normalized, params.text);
    return dedupeAndLimitEntities(
      collapsed.map((token) => ({
        text: token.text,
        type: token.type,
        score: token.score,
      })),
      this.cfg.maxEntitiesPerMemory,
    );
  }
}

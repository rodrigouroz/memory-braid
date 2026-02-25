import { randomUUID } from "node:crypto";
import type { MemoryBraidConfig } from "./config.js";

type LoggerLike = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type LogContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  workspaceHash?: string;
  durMs?: number;
  [key: string]: unknown;
};

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function sanitizeValue(value: unknown, maxChars: number, includePayloads: boolean): unknown {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, maxChars);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, maxChars, includePayloads));
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!includePayloads && /payload|content|snippet|text|prompt|body/i.test(key)) {
      out[key] = "[omitted]";
      continue;
    }
    out[key] = sanitizeValue(entry, maxChars, includePayloads);
  }
  return out;
}

export class MemoryBraidLogger {
  private readonly base: LoggerLike;
  private readonly cfg: MemoryBraidConfig["debug"];

  constructor(base: LoggerLike, cfg: MemoryBraidConfig["debug"]) {
    this.base = base;
    this.cfg = cfg;
  }

  newRunId(): string {
    return randomUUID();
  }

  info(event: string, context: LogContext = {}): void {
    this.emit("info", event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.emit("warn", event, context);
  }

  error(event: string, context: LogContext = {}): void {
    this.emit("error", event, context);
  }

  debug(event: string, context: LogContext = {}, always = false): void {
    this.emit("debug", event, context, always);
  }

  private shouldSample(): boolean {
    if (this.cfg.logSamplingRate >= 1) {
      return true;
    }
    if (this.cfg.logSamplingRate <= 0) {
      return false;
    }
    return Math.random() <= this.cfg.logSamplingRate;
  }

  private emit(level: "debug" | "info" | "warn" | "error", event: string, context: LogContext, always = false): void {
    if (level === "debug" && !always && !this.cfg.enabled) {
      return;
    }
    if (!always && !this.shouldSample()) {
      return;
    }

    const payload = {
      event,
      ts: new Date().toISOString(),
      ...sanitizeValue(context, this.cfg.maxSnippetChars, this.cfg.includePayloads),
    };
    const message = `memory-braid ${JSON.stringify(payload)}`;

    if (level === "debug") {
      if (this.base.debug) {
        this.base.debug(message);
      } else {
        this.base.info(`[debug] ${message}`);
      }
      return;
    }

    if (level === "info") {
      this.base.info(message);
      return;
    }
    if (level === "warn") {
      this.base.warn(message);
      return;
    }
    this.base.error(message);
  }
}

export type MemoryBraidConfig = {
  enabled: boolean;
  mem0: {
    mode: "cloud" | "oss";
    apiKey?: string;
    host?: string;
    organizationId?: string;
    projectId?: string;
    ossConfig: Record<string, unknown>;
  };
  recall: {
    maxResults: number;
    injectTopK: number;
    merge: {
      strategy: "rrf";
      rrfK: number;
      localWeight: number;
      mem0Weight: number;
    };
  };
  capture: {
    enabled: boolean;
    extraction: {
      mode: "heuristic" | "heuristic_plus_ml";
    };
    ml: {
      provider?: "openai" | "anthropic" | "gemini";
      model?: string;
      timeoutMs: number;
      maxItemsPerRun: number;
    };
  };
  bootstrap: {
    enabled: boolean;
    startupMode: "async";
    includeMarkdown: boolean;
    includeSessions: boolean;
    sessionLookbackDays: number;
    batchSize: number;
    concurrency: number;
  };
  reconcile: {
    enabled: boolean;
    intervalMinutes: number;
    batchSize: number;
    deleteStale: boolean;
  };
  dedupe: {
    lexical: {
      minJaccard: number;
    };
    semantic: {
      enabled: boolean;
      minScore: number;
    };
  };
  debug: {
    enabled: boolean;
    includePayloads: boolean;
    maxSnippetChars: number;
    logSamplingRate: number;
  };
};

const DEFAULTS: MemoryBraidConfig = {
  enabled: true,
  mem0: {
    mode: "cloud",
    apiKey: undefined,
    host: undefined,
    organizationId: undefined,
    projectId: undefined,
    ossConfig: {},
  },
  recall: {
    maxResults: 8,
    injectTopK: 5,
    merge: {
      strategy: "rrf",
      rrfK: 60,
      localWeight: 1,
      mem0Weight: 1,
    },
  },
  capture: {
    enabled: true,
    extraction: {
      mode: "heuristic",
    },
    ml: {
      provider: undefined,
      model: undefined,
      timeoutMs: 2500,
      maxItemsPerRun: 6,
    },
  },
  bootstrap: {
    enabled: true,
    startupMode: "async",
    includeMarkdown: true,
    includeSessions: true,
    sessionLookbackDays: 90,
    batchSize: 50,
    concurrency: 3,
  },
  reconcile: {
    enabled: true,
    intervalMinutes: 30,
    batchSize: 100,
    deleteStale: true,
  },
  dedupe: {
    lexical: {
      minJaccard: 0.3,
    },
    semantic: {
      enabled: true,
      minScore: 0.92,
    },
  },
  debug: {
    enabled: false,
    includePayloads: false,
    maxSnippetChars: 500,
    logSamplingRate: 1,
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(asNumber(value, fallback, min, max));
}

export function parseConfig(raw: unknown): MemoryBraidConfig {
  const root = asRecord(raw);
  const mem0 = asRecord(root.mem0);
  const recall = asRecord(root.recall);
  const merge = asRecord(recall.merge);
  const capture = asRecord(root.capture);
  const extraction = asRecord(capture.extraction);
  const ml = asRecord(capture.ml);
  const bootstrap = asRecord(root.bootstrap);
  const reconcile = asRecord(root.reconcile);
  const dedupe = asRecord(root.dedupe);
  const lexical = asRecord(dedupe.lexical);
  const semantic = asRecord(dedupe.semantic);
  const debug = asRecord(root.debug);

  const mode = mem0.mode === "oss" ? "oss" : "cloud";
  const extractionMode =
    extraction.mode === "heuristic_plus_ml" ? "heuristic_plus_ml" : "heuristic";

  return {
    enabled: asBoolean(root.enabled, DEFAULTS.enabled),
    mem0: {
      mode,
      apiKey: asString(mem0.apiKey),
      host: asString(mem0.host),
      organizationId: asString(mem0.organizationId),
      projectId: asString(mem0.projectId),
      ossConfig: asRecord(mem0.ossConfig),
    },
    recall: {
      maxResults: asInt(recall.maxResults, DEFAULTS.recall.maxResults, 1, 50),
      injectTopK: asInt(recall.injectTopK, DEFAULTS.recall.injectTopK, 1, 20),
      merge: {
        strategy: "rrf",
        rrfK: asInt(merge.rrfK, DEFAULTS.recall.merge.rrfK, 1, 500),
        localWeight: asNumber(merge.localWeight, DEFAULTS.recall.merge.localWeight, 0, 5),
        mem0Weight: asNumber(merge.mem0Weight, DEFAULTS.recall.merge.mem0Weight, 0, 5),
      },
    },
    capture: {
      enabled: asBoolean(capture.enabled, DEFAULTS.capture.enabled),
      extraction: {
        mode: extractionMode,
      },
      ml: {
        provider:
          ml.provider === "openai" || ml.provider === "anthropic" || ml.provider === "gemini"
            ? ml.provider
            : DEFAULTS.capture.ml.provider,
        model: asString(ml.model),
        timeoutMs: asInt(ml.timeoutMs, DEFAULTS.capture.ml.timeoutMs, 250, 30_000),
        maxItemsPerRun: asInt(ml.maxItemsPerRun, DEFAULTS.capture.ml.maxItemsPerRun, 1, 50),
      },
    },
    bootstrap: {
      enabled: asBoolean(bootstrap.enabled, DEFAULTS.bootstrap.enabled),
      startupMode: "async",
      includeMarkdown: asBoolean(bootstrap.includeMarkdown, DEFAULTS.bootstrap.includeMarkdown),
      includeSessions: asBoolean(bootstrap.includeSessions, DEFAULTS.bootstrap.includeSessions),
      sessionLookbackDays: asInt(
        bootstrap.sessionLookbackDays,
        DEFAULTS.bootstrap.sessionLookbackDays,
        1,
        3650,
      ),
      batchSize: asInt(bootstrap.batchSize, DEFAULTS.bootstrap.batchSize, 1, 1000),
      concurrency: asInt(bootstrap.concurrency, DEFAULTS.bootstrap.concurrency, 1, 16),
    },
    reconcile: {
      enabled: asBoolean(reconcile.enabled, DEFAULTS.reconcile.enabled),
      intervalMinutes: asInt(
        reconcile.intervalMinutes,
        DEFAULTS.reconcile.intervalMinutes,
        1,
        1440,
      ),
      batchSize: asInt(reconcile.batchSize, DEFAULTS.reconcile.batchSize, 1, 5000),
      deleteStale: asBoolean(reconcile.deleteStale, DEFAULTS.reconcile.deleteStale),
    },
    dedupe: {
      lexical: {
        minJaccard: asNumber(lexical.minJaccard, DEFAULTS.dedupe.lexical.minJaccard, 0, 1),
      },
      semantic: {
        enabled: asBoolean(semantic.enabled, DEFAULTS.dedupe.semantic.enabled),
        minScore: asNumber(semantic.minScore, DEFAULTS.dedupe.semantic.minScore, 0, 1),
      },
    },
    debug: {
      enabled: asBoolean(debug.enabled, DEFAULTS.debug.enabled),
      includePayloads: asBoolean(debug.includePayloads, DEFAULTS.debug.includePayloads),
      maxSnippetChars: asInt(debug.maxSnippetChars, DEFAULTS.debug.maxSnippetChars, 40, 8000),
      logSamplingRate: asNumber(debug.logSamplingRate, DEFAULTS.debug.logSamplingRate, 0, 1),
    },
  };
}

export const pluginConfigSchema = {
  parse(value: unknown) {
    return parseConfig(value);
  },
  safeParse(value: unknown) {
    try {
      const data = parseConfig(value);
      return { success: true as const, data };
    } catch (err) {
      return {
        success: false as const,
        error: {
          issues: [{ path: [], message: err instanceof Error ? err.message : String(err) }],
        },
      };
    }
  },
};

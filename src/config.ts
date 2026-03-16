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
    user: {
      enabled: boolean;
      injectTopK: number;
    };
    agent: {
      enabled: boolean;
      injectTopK: number;
      minScore: number;
      onlyPlanning: boolean;
    };
    merge: {
      strategy: "rrf";
      rrfK: number;
      localWeight: number;
      mem0Weight: number;
    };
  };
  capture: {
    enabled: boolean;
    mode: "local" | "hybrid" | "ml";
    includeAssistant: boolean;
    maxItemsPerRun: number;
    selection: {
      minPreferenceDecisionScore: number;
      minFactScore: number;
      minTaskScore: number;
      minOtherScore: number;
      minProceduralScore: number;
    };
    assistant: {
      enabled: boolean;
      autoCapture: boolean;
      explicitTool: boolean;
      maxItemsPerRun: number;
      minUtilityScore: number;
      minNoveltyScore: number;
      maxWritesPerSessionWindow: number;
      cooldownMinutes: number;
    };
    ml: {
      provider?: "openai" | "anthropic" | "gemini";
      model?: string;
      timeoutMs: number;
    };
  };
  entityExtraction: {
    enabled: boolean;
    provider: "multilingual_ner" | "openai";
    model: string;
    timeoutMs: number;
    minScore: number;
    maxEntitiesPerMemory: number;
    startup: {
      downloadOnStartup: boolean;
      warmupText: string;
    };
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
  timeDecay: {
    enabled: boolean;
  };
  lifecycle: {
    enabled: boolean;
    captureTtlDays: number;
    cleanupIntervalMinutes: number;
    reinforceOnRecall: boolean;
  };
  consolidation: {
    enabled: boolean;
    startupRun: boolean;
    intervalMinutes: number;
    opportunisticNewMemoryThreshold: number;
    opportunisticMinMinutesSinceLastRun: number;
    minSupportCount: number;
    minRecallCount: number;
    minSelectionScore: number;
    semanticMaxSourceIds: number;
    timeQueryParsing: boolean;
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
    user: {
      enabled: true,
      injectTopK: 5,
    },
    agent: {
      enabled: true,
      injectTopK: 2,
      minScore: 0.78,
      onlyPlanning: true,
    },
    merge: {
      strategy: "rrf",
      rrfK: 60,
      localWeight: 1,
      mem0Weight: 1,
    },
  },
  capture: {
    enabled: true,
    mode: "local",
    includeAssistant: false,
    maxItemsPerRun: 6,
    selection: {
      minPreferenceDecisionScore: 0.45,
      minFactScore: 0.52,
      minTaskScore: 0.72,
      minOtherScore: 0.82,
      minProceduralScore: 0.58,
    },
    assistant: {
      enabled: true,
      autoCapture: false,
      explicitTool: true,
      maxItemsPerRun: 2,
      minUtilityScore: 0.8,
      minNoveltyScore: 0.85,
      maxWritesPerSessionWindow: 3,
      cooldownMinutes: 5,
    },
    ml: {
      provider: undefined,
      model: undefined,
      timeoutMs: 2500,
    },
  },
  entityExtraction: {
    enabled: false,
    provider: "multilingual_ner",
    model: "Xenova/bert-base-multilingual-cased-ner-hrl",
    timeoutMs: 2500,
    minScore: 0.65,
    maxEntitiesPerMemory: 8,
    startup: {
      downloadOnStartup: false,
      warmupText: "John works at Acme in Berlin.",
    },
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
  timeDecay: {
    enabled: false,
  },
  lifecycle: {
    enabled: false,
    captureTtlDays: 90,
    cleanupIntervalMinutes: 360,
    reinforceOnRecall: true,
  },
  consolidation: {
    enabled: true,
    startupRun: false,
    intervalMinutes: 360,
    opportunisticNewMemoryThreshold: 5,
    opportunisticMinMinutesSinceLastRun: 30,
    minSupportCount: 2,
    minRecallCount: 2,
    minSelectionScore: 0.56,
    semanticMaxSourceIds: 20,
    timeQueryParsing: true,
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
  const recallUser = asRecord(recall.user);
  const recallAgent = asRecord(recall.agent);
  const merge = asRecord(recall.merge);
  const capture = asRecord(root.capture);
  const captureSelection = asRecord(capture.selection);
  const captureAssistant = asRecord(capture.assistant);
  const entityExtraction = asRecord(root.entityExtraction);
  const entityStartup = asRecord(entityExtraction.startup);
  const ml = asRecord(capture.ml);
  const dedupe = asRecord(root.dedupe);
  const lexical = asRecord(dedupe.lexical);
  const semantic = asRecord(dedupe.semantic);
  const timeDecay = asRecord(root.timeDecay);
  const lifecycle = asRecord(root.lifecycle);
  const consolidation = asRecord(root.consolidation);
  const debug = asRecord(root.debug);

  const mode = mem0.mode === "oss" ? "oss" : "cloud";
  const rawCaptureMode = asString(capture.mode)?.toLowerCase();
  const captureMode =
    rawCaptureMode === "local" || rawCaptureMode === "hybrid" || rawCaptureMode === "ml"
      ? rawCaptureMode
      : DEFAULTS.capture.mode;
  const entityProvider = entityExtraction.provider === "openai" ? "openai" : "multilingual_ner";
  const parsedEntityModel = asString(entityExtraction.model);
  const entityModel =
    entityProvider === "openai"
      ? parsedEntityModel && parsedEntityModel !== DEFAULTS.entityExtraction.model
        ? parsedEntityModel
        : "gpt-4o-mini"
      : parsedEntityModel ?? DEFAULTS.entityExtraction.model;
  const includeAssistant = asBoolean(
    capture.includeAssistant,
    DEFAULTS.capture.includeAssistant,
  );
  const legacyInjectTopK = asInt(
    recall.injectTopK,
    DEFAULTS.recall.injectTopK,
    1,
    20,
  );

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
      injectTopK: legacyInjectTopK,
      user: {
        enabled: asBoolean(recallUser.enabled, DEFAULTS.recall.user.enabled),
        injectTopK: asInt(
          recallUser.injectTopK,
          legacyInjectTopK,
          1,
          20,
        ),
      },
      agent: {
        enabled: asBoolean(recallAgent.enabled, DEFAULTS.recall.agent.enabled),
        injectTopK: asInt(
          recallAgent.injectTopK,
          DEFAULTS.recall.agent.injectTopK,
          1,
          20,
        ),
        minScore: asNumber(
          recallAgent.minScore,
          DEFAULTS.recall.agent.minScore,
          0,
          1,
        ),
        onlyPlanning: asBoolean(
          recallAgent.onlyPlanning,
          DEFAULTS.recall.agent.onlyPlanning,
        ),
      },
      merge: {
        strategy: "rrf",
        rrfK: asInt(merge.rrfK, DEFAULTS.recall.merge.rrfK, 1, 500),
        localWeight: asNumber(merge.localWeight, DEFAULTS.recall.merge.localWeight, 0, 5),
        mem0Weight: asNumber(merge.mem0Weight, DEFAULTS.recall.merge.mem0Weight, 0, 5),
      },
    },
    capture: {
      enabled: asBoolean(capture.enabled, DEFAULTS.capture.enabled),
      mode: captureMode,
      includeAssistant,
      maxItemsPerRun: asInt(capture.maxItemsPerRun, DEFAULTS.capture.maxItemsPerRun, 1, 50),
      selection: {
        minPreferenceDecisionScore: asNumber(
          captureSelection.minPreferenceDecisionScore,
          DEFAULTS.capture.selection.minPreferenceDecisionScore,
          0,
          1,
        ),
        minFactScore: asNumber(
          captureSelection.minFactScore,
          DEFAULTS.capture.selection.minFactScore,
          0,
          1,
        ),
        minTaskScore: asNumber(
          captureSelection.minTaskScore,
          DEFAULTS.capture.selection.minTaskScore,
          0,
          1,
        ),
        minOtherScore: asNumber(
          captureSelection.minOtherScore,
          DEFAULTS.capture.selection.minOtherScore,
          0,
          1,
        ),
        minProceduralScore: asNumber(
          captureSelection.minProceduralScore,
          DEFAULTS.capture.selection.minProceduralScore,
          0,
          1,
        ),
      },
      assistant: {
        enabled: asBoolean(
          captureAssistant.enabled,
          DEFAULTS.capture.assistant.enabled,
        ),
        autoCapture: asBoolean(
          captureAssistant.autoCapture,
          includeAssistant,
        ),
        explicitTool: asBoolean(
          captureAssistant.explicitTool,
          DEFAULTS.capture.assistant.explicitTool,
        ),
        maxItemsPerRun: asInt(
          captureAssistant.maxItemsPerRun,
          DEFAULTS.capture.assistant.maxItemsPerRun,
          1,
          10,
        ),
        minUtilityScore: asNumber(
          captureAssistant.minUtilityScore,
          DEFAULTS.capture.assistant.minUtilityScore,
          0,
          1,
        ),
        minNoveltyScore: asNumber(
          captureAssistant.minNoveltyScore,
          DEFAULTS.capture.assistant.minNoveltyScore,
          0,
          1,
        ),
        maxWritesPerSessionWindow: asInt(
          captureAssistant.maxWritesPerSessionWindow,
          DEFAULTS.capture.assistant.maxWritesPerSessionWindow,
          1,
          20,
        ),
        cooldownMinutes: asInt(
          captureAssistant.cooldownMinutes,
          DEFAULTS.capture.assistant.cooldownMinutes,
          0,
          240,
        ),
      },
      ml: {
        provider:
          ml.provider === "openai" || ml.provider === "anthropic" || ml.provider === "gemini"
            ? ml.provider
            : DEFAULTS.capture.ml.provider,
        model: asString(ml.model),
        timeoutMs: asInt(ml.timeoutMs, DEFAULTS.capture.ml.timeoutMs, 250, 30_000),
      },
    },
    entityExtraction: {
      enabled: asBoolean(entityExtraction.enabled, DEFAULTS.entityExtraction.enabled),
      provider: entityProvider,
      model: entityModel,
      timeoutMs: asInt(
        entityExtraction.timeoutMs,
        DEFAULTS.entityExtraction.timeoutMs,
        250,
        30_000,
      ),
      minScore: asNumber(entityExtraction.minScore, DEFAULTS.entityExtraction.minScore, 0, 1),
      maxEntitiesPerMemory: asInt(
        entityExtraction.maxEntitiesPerMemory,
        DEFAULTS.entityExtraction.maxEntitiesPerMemory,
        1,
        50,
      ),
      startup: {
        downloadOnStartup: asBoolean(
          entityStartup.downloadOnStartup,
          DEFAULTS.entityExtraction.startup.downloadOnStartup,
        ),
        warmupText:
          asString(entityStartup.warmupText) ?? DEFAULTS.entityExtraction.startup.warmupText,
      },
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
    timeDecay: {
      enabled: asBoolean(timeDecay.enabled, DEFAULTS.timeDecay.enabled),
    },
    lifecycle: {
      enabled: asBoolean(lifecycle.enabled, DEFAULTS.lifecycle.enabled),
      captureTtlDays: asInt(
        lifecycle.captureTtlDays,
        DEFAULTS.lifecycle.captureTtlDays,
        1,
        3650,
      ),
      cleanupIntervalMinutes: asInt(
        lifecycle.cleanupIntervalMinutes,
        DEFAULTS.lifecycle.cleanupIntervalMinutes,
        1,
        10080,
      ),
      reinforceOnRecall: asBoolean(
        lifecycle.reinforceOnRecall,
        DEFAULTS.lifecycle.reinforceOnRecall,
      ),
    },
    consolidation: {
      enabled: asBoolean(consolidation.enabled, DEFAULTS.consolidation.enabled),
      startupRun: asBoolean(consolidation.startupRun, DEFAULTS.consolidation.startupRun),
      intervalMinutes: asInt(
        consolidation.intervalMinutes,
        DEFAULTS.consolidation.intervalMinutes,
        1,
        10080,
      ),
      opportunisticNewMemoryThreshold: asInt(
        consolidation.opportunisticNewMemoryThreshold,
        DEFAULTS.consolidation.opportunisticNewMemoryThreshold,
        1,
        100,
      ),
      opportunisticMinMinutesSinceLastRun: asInt(
        consolidation.opportunisticMinMinutesSinceLastRun,
        DEFAULTS.consolidation.opportunisticMinMinutesSinceLastRun,
        1,
        1440,
      ),
      minSupportCount: asInt(
        consolidation.minSupportCount,
        DEFAULTS.consolidation.minSupportCount,
        1,
        50,
      ),
      minRecallCount: asInt(
        consolidation.minRecallCount,
        DEFAULTS.consolidation.minRecallCount,
        1,
        100,
      ),
      minSelectionScore: asNumber(
        consolidation.minSelectionScore,
        DEFAULTS.consolidation.minSelectionScore,
        0,
        1,
      ),
      semanticMaxSourceIds: asInt(
        consolidation.semanticMaxSourceIds,
        DEFAULTS.consolidation.semanticMaxSourceIds,
        1,
        200,
      ),
      timeQueryParsing: asBoolean(
        consolidation.timeQueryParsing,
        DEFAULTS.consolidation.timeQueryParsing,
      ),
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

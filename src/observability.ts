type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type UsageSnapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  promptTokens: number;
  cacheHitRate: number;
  cacheWriteRate: number;
  estimatedCostUsd?: number;
  costEstimateBasis: "estimated" | "token_only";
};

export type TrendState = "rising" | "stable" | "improving" | "insufficient_data";

export type UsageWindowEntry = UsageSnapshot & {
  at: number;
  runId: string;
};

export type UsageTrendSummary = {
  turnsSeen: number;
  window5: {
    avgPromptTokens: number;
    avgCacheRead: number;
    avgCacheWrite: number;
    avgCacheHitRate: number;
    avgCacheWriteRate: number;
    avgEstimatedCostUsd?: number;
  };
  window20: {
    avgPromptTokens: number;
    avgCacheRead: number;
    avgCacheWrite: number;
    avgCacheHitRate: number;
    avgCacheWriteRate: number;
    avgEstimatedCostUsd?: number;
  };
  trends: {
    cacheWriteRate: TrendState;
    cacheHitRate: TrendState;
    promptTokens: TrendState;
    estimatedCostUsd: TrendState;
  };
  alerts: string[];
};

type PriceConfig = {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
};

const WINDOW_LIMIT = 20;

const PRICE_CONFIGS: Array<{
  provider: string;
  match: RegExp;
  price: PriceConfig;
}> = [
  {
    provider: "anthropic",
    match: /claude-.*opus/i,
    price: {
      inputPerM: 15,
      outputPerM: 75,
      cacheReadPerM: 1.5,
      cacheWritePerM: 18.75,
    },
  },
  {
    provider: "anthropic",
    match: /claude-.*sonnet/i,
    price: {
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: 0.3,
      cacheWritePerM: 3.75,
    },
  },
  {
    provider: "anthropic",
    match: /claude-.*haiku/i,
    price: {
      inputPerM: 0.8,
      outputPerM: 4,
      cacheReadPerM: 0.08,
      cacheWritePerM: 1,
    },
  },
  {
    provider: "openai",
    match: /^gpt-4o$/i,
    price: {
      inputPerM: 2.5,
      outputPerM: 10,
      cacheReadPerM: 1.25,
      cacheWritePerM: 1.25,
    },
  },
  {
    provider: "openai",
    match: /^gpt-4o-mini$/i,
    price: {
      inputPerM: 0.15,
      outputPerM: 0.6,
      cacheReadPerM: 0.075,
      cacheWritePerM: 0.075,
    },
  },
];

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageOptional(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === "number");
  if (filtered.length === 0) {
    return undefined;
  }
  return average(filtered);
}

function resolvePriceConfig(provider: string, model: string): PriceConfig | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  for (const candidate of PRICE_CONFIGS) {
    if (candidate.provider !== normalizedProvider) {
      continue;
    }
    if (candidate.match.test(model)) {
      return candidate.price;
    }
  }
  return undefined;
}

export function createUsageSnapshot(params: {
  provider: string;
  model: string;
  usage?: UsageLike;
}): UsageSnapshot {
  const input = finite(params.usage?.input);
  const output = finite(params.usage?.output);
  const cacheRead = finite(params.usage?.cacheRead);
  const cacheWrite = finite(params.usage?.cacheWrite);
  const total = finite(params.usage?.total) || input + output + cacheRead + cacheWrite;
  const promptTokens = input + cacheRead + cacheWrite;
  const cacheBase = Math.max(1, promptTokens);
  const price = resolvePriceConfig(params.provider, params.model);
  const estimatedCostUsd = price
    ? (input / 1_000_000) * price.inputPerM +
      (output / 1_000_000) * price.outputPerM +
      (cacheRead / 1_000_000) * (price.cacheReadPerM ?? price.inputPerM) +
      (cacheWrite / 1_000_000) * (price.cacheWritePerM ?? price.inputPerM)
    : undefined;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    promptTokens,
    cacheHitRate: cacheRead / cacheBase,
    cacheWriteRate: cacheWrite / cacheBase,
    estimatedCostUsd,
    costEstimateBasis: estimatedCostUsd === undefined ? "token_only" : "estimated",
  };
}

function classifyTrend(current: number | undefined, prior: number | undefined): TrendState {
  if (typeof current !== "number" || typeof prior !== "number" || prior <= 0) {
    return "insufficient_data";
  }
  if (current >= prior * 1.2) {
    return "rising";
  }
  if (current <= prior * 0.85) {
    return "improving";
  }
  return "stable";
}

function movingWindow(entries: UsageWindowEntry[], size: number): UsageWindowEntry[] {
  return entries.slice(Math.max(0, entries.length - size));
}

function previousWindow(entries: UsageWindowEntry[], size: number): UsageWindowEntry[] {
  const end = Math.max(0, entries.length - size);
  const start = Math.max(0, end - size);
  return entries.slice(start, end);
}

function summarizeWindow(entries: UsageWindowEntry[]) {
  return {
    avgPromptTokens: average(entries.map((entry) => entry.promptTokens)),
    avgCacheRead: average(entries.map((entry) => entry.cacheRead)),
    avgCacheWrite: average(entries.map((entry) => entry.cacheWrite)),
    avgCacheHitRate: average(entries.map((entry) => entry.cacheHitRate)),
    avgCacheWriteRate: average(entries.map((entry) => entry.cacheWriteRate)),
    avgEstimatedCostUsd: averageOptional(entries.map((entry) => entry.estimatedCostUsd)),
  };
}

export function appendUsageWindow(
  history: UsageWindowEntry[],
  entry: UsageWindowEntry,
): UsageWindowEntry[] {
  const next = [...history, entry];
  if (next.length <= WINDOW_LIMIT) {
    return next;
  }
  return next.slice(next.length - WINDOW_LIMIT);
}

export function summarizeUsageWindow(history: UsageWindowEntry[]): UsageTrendSummary {
  const window5Entries = movingWindow(history, 5);
  const window20Entries = movingWindow(history, 20);
  const prior5Entries = previousWindow(history, 5);
  const current5 = summarizeWindow(window5Entries);
  const current20 = summarizeWindow(window20Entries);
  const prior5 = summarizeWindow(prior5Entries);

  const cacheWriteRateTrend = classifyTrend(current5.avgCacheWriteRate, prior5.avgCacheWriteRate);
  const cacheHitRateTrend = classifyTrend(current5.avgCacheHitRate, prior5.avgCacheHitRate);
  const promptTokensTrend = classifyTrend(current5.avgPromptTokens, prior5.avgPromptTokens);
  const costTrend = classifyTrend(current5.avgEstimatedCostUsd, prior5.avgEstimatedCostUsd);

  const alerts: string[] = [];
  if (cacheWriteRateTrend === "rising" && current5.avgCacheWriteRate >= 0.12) {
    alerts.push("cache_write_rate_rising");
  }
  if (promptTokensTrend === "rising" && current5.avgPromptTokens >= 20_000) {
    alerts.push("prompt_tokens_rising");
  }
  if (costTrend === "rising" && (current5.avgEstimatedCostUsd ?? 0) >= 0.05) {
    alerts.push("estimated_cost_rising");
  }

  return {
    turnsSeen: history.length,
    window5: current5,
    window20: current20,
    trends: {
      cacheWriteRate: cacheWriteRateTrend,
      cacheHitRate: cacheHitRateTrend,
      promptTokens: promptTokensTrend,
      estimatedCostUsd: costTrend,
    },
    alerts,
  };
}

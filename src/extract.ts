import { normalizeForHash, normalizeWhitespace, sha256 } from "./chunking.js";
import type { MemoryBraidConfig } from "./config.js";
import { isLikelyTranscriptLikeText, isOversizedAtomicMemory } from "./capture.js";
import { MemoryBraidLogger } from "./logger.js";
import type { ExtractedCandidate } from "./types.js";

type MlProvider = "openai" | "anthropic" | "gemini";

const HEURISTIC_PATTERNS = [
  /remember|remember that|keep in mind|note that/i,
  /i prefer|prefer to|don't like|do not like|hate|love/i,
  /we decided|decision|let's use|we will use/i,
  /my name is|i am|contact me at|email is|phone is/i,
  /deadline|due date|todo|action item|follow up/i,
];
const HEURISTIC_LOOKBACK_MULTIPLIER = 4;
const HEURISTIC_MIN_LOOKBACK_MESSAGES = 12;
const FEED_TAG_PATTERN = /\[(?:n8n|rss|alert|news|cron|slack|discord|telegram|email|github|jira)[^[]*]/i;
const ROLE_LABEL_PATTERN = /\b(?:assistant|system|tool|developer)\s*:/gi;

function isLikelyFeedOrImportedText(text: string): boolean {
  if (isLikelyTranscriptLikeText(text) || isOversizedAtomicMemory(text)) {
    return true;
  }
  if (FEED_TAG_PATTERN.test(text)) {
    return true;
  }

  const roleLabels = text.match(ROLE_LABEL_PATTERN)?.length ?? 0;
  if (roleLabels >= 2) {
    return true;
  }

  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }

  const rolePrefixedLines = lines.filter((line) =>
    /^(assistant|system|tool|developer|user)\s*:/i.test(line),
  ).length;
  return rolePrefixedLines >= 2;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return normalizeWhitespace(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const item = block as { type?: unknown; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") {
      const normalized = normalizeWhitespace(item.text);
      if (normalized) {
        parts.push(normalized);
      }
    }
  }
  return parts.join(" ");
}

function normalizeMessages(messages: unknown[]): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const direct = entry as { role?: unknown; content?: unknown };
    if (typeof direct.role === "string") {
      const text = extractMessageText(direct.content);
      if (text) {
        out.push({ role: direct.role, text });
      }
      continue;
    }

    const wrapped = entry as { message?: { role?: unknown; content?: unknown } };
    if (wrapped.message && typeof wrapped.message.role === "string") {
      const text = extractMessageText(wrapped.message.content);
      if (text) {
        out.push({ role: wrapped.message.role, text });
      }
    }
  }
  return out;
}

function scoreHeuristic(text: string): number {
  let score = 0;
  for (const pattern of HEURISTIC_PATTERNS) {
    if (pattern.test(text)) {
      score += 0.25;
    }
  }
  if (text.length > 40) {
    score += 0.15;
  }
  return Math.min(1, score);
}

function classifyCategory(text: string): ExtractedCandidate["category"] {
  if (/prefer|like|love|hate|don't like|do not like/i.test(text)) {
    return "preference";
  }
  if (/we decided|decision|let's use|we will use/i.test(text)) {
    return "decision";
  }
  if (/todo|action item|follow up|deadline|due date/i.test(text)) {
    return "task";
  }
  if (/my name is|contact|email|phone|address|timezone/i.test(text)) {
    return "fact";
  }
  return "other";
}

function pickHeuristicCandidates(
  messages: Array<{ role: string; text: string }>,
  maxItems: number,
): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];
  const seen = new Set<string>();
  const lookback = Math.max(HEURISTIC_MIN_LOOKBACK_MESSAGES, maxItems * HEURISTIC_LOOKBACK_MULTIPLIER);
  const startIndex = Math.max(0, messages.length - lookback);

  for (let i = messages.length - 1; i >= startIndex; i -= 1) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    if (message.text.length < 20 || message.text.length > 3000) {
      continue;
    }
    if (isLikelyFeedOrImportedText(message.text)) {
      continue;
    }

    const score = scoreHeuristic(message.text);
    if (score < 0.2) {
      continue;
    }

    const key = sha256(normalizeForHash(message.text));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      text: message.text,
      category: classifyCategory(message.text),
      score,
      source: "heuristic",
    });
    if (out.length >= maxItems) {
      break;
    }
  }

  return out;
}

function parseJsonObjectArray(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => entry && typeof entry === "object") as Array<
      Record<string, unknown>
    >;
  } catch {
    return [];
  }
}

async function callMlEnrichment(params: {
  provider: MlProvider;
  model: string;
  timeoutMs: number;
  candidates: ExtractedCandidate[];
}): Promise<Array<Record<string, unknown>>> {
  const prompt = [
    "Classify the memory candidates.",
    "Return ONLY JSON array.",
    "Each item: {index:number, keep:boolean, category:string, score:number}.",
    "Category one of: preference, decision, fact, task, other.",
    JSON.stringify(params.candidates.map((candidate, index) => ({ index, text: candidate.text }))),
  ].join("\n");
  return callMlJson({
    provider: params.provider,
    model: params.model,
    timeoutMs: params.timeoutMs,
    prompt,
  });
}

async function callMlExtraction(params: {
  provider: MlProvider;
  model: string;
  timeoutMs: number;
  maxItems: number;
  messages: Array<{ role: string; text: string }>;
}): Promise<Array<Record<string, unknown>>> {
  const recent = params.messages.slice(-30).map((item) => ({
    role: item.role,
    text: item.text,
  }));

  const prompt = [
    "Extract durable user memories from this conversation.",
    "Return ONLY JSON array.",
    "Each item: {text:string, category:string, score:number}.",
    "Category one of: preference, decision, fact, task, other.",
    "Keep each text concise and atomic.",
    `Maximum items: ${params.maxItems}.`,
    JSON.stringify(recent),
  ].join("\n");

  return callMlJson({
    provider: params.provider,
    model: params.model,
    timeoutMs: params.timeoutMs,
    prompt,
  });
}

async function callMlJson(params: {
  provider: MlProvider;
  model: string;
  timeoutMs: number;
  prompt: string;
}): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    if (params.provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        return [];
      }
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "You return strict JSON only.",
            },
            {
              role: "user",
              content: params.prompt,
            },
          ],
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      return parseJsonObjectArray(content);
    }

    if (params.provider === "anthropic") {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        return [];
      }
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: 1000,
          temperature: 0,
          messages: [{ role: "user", content: params.prompt }],
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = data.content?.find((item) => item.type === "text")?.text ?? "";
      return parseJsonObjectArray(text);
    }

    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      return [];
    }
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          generationConfig: { temperature: 0 },
          contents: [{ role: "user", parts: [{ text: params.prompt }] }],
        }),
        signal: controller.signal,
      },
    );
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return parseJsonObjectArray(text);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCategory(value: unknown, fallback: ExtractedCandidate["category"] = "other"): ExtractedCandidate["category"] {
  if (
    value === "preference" ||
    value === "decision" ||
    value === "fact" ||
    value === "task" ||
    value === "other"
  ) {
    return value;
  }
  return fallback;
}

function applyMlResult(
  candidates: ExtractedCandidate[],
  result: Array<Record<string, unknown>>,
): ExtractedCandidate[] {
  if (result.length === 0) {
    return candidates;
  }

  const byIndex = new Map<number, Record<string, unknown>>();
  for (const item of result) {
    const index = typeof item.index === "number" ? item.index : -1;
    if (index >= 0) {
      byIndex.set(index, item);
    }
  }

  const out: ExtractedCandidate[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate) {
      continue;
    }
    const ml = byIndex.get(i);
    if (!ml) {
      out.push(candidate);
      continue;
    }
    const keep = typeof ml.keep === "boolean" ? ml.keep : true;
    if (!keep) {
      continue;
    }
    const category = normalizeCategory(ml.category, candidate.category);
    const score = typeof ml.score === "number" ? Math.max(0, Math.min(1, ml.score)) : candidate.score;
    out.push({
      ...candidate,
      category,
      score,
      source: "ml",
    });
  }
  return out;
}

function applyMlExtractionResult(
  result: Array<Record<string, unknown>>,
  maxItems: number,
): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];
  const seen = new Set<string>();

  for (const item of result) {
    const rawText = typeof item.text === "string" ? item.text : "";
    const text = normalizeWhitespace(rawText);
    if (!text || text.length < 20 || text.length > 3000) {
      continue;
    }
    if (isLikelyFeedOrImportedText(text)) {
      continue;
    }
    const key = sha256(normalizeForHash(text));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    out.push({
      text,
      category: normalizeCategory(item.category),
      score: typeof item.score === "number" ? Math.max(0, Math.min(1, item.score)) : 0.5,
      source: "ml",
    });
    if (out.length >= maxItems) {
      break;
    }
  }

  return out;
}

export async function extractCandidates(params: {
  messages: unknown[];
  cfg: MemoryBraidConfig;
  log: MemoryBraidLogger;
  runId?: string;
}): Promise<ExtractedCandidate[]> {
  const normalized = normalizeMessages(params.messages);
  const captureFromAssistant = params.cfg.capture.includeAssistant;
  const candidatesInput = normalized.filter((message) =>
    captureFromAssistant
      ? message.role === "user" || message.role === "assistant"
      : message.role === "user",
  );
  const heuristic = pickHeuristicCandidates(candidatesInput, params.cfg.capture.maxItemsPerRun);

  params.log.debug("memory_braid.capture.extract", {
    runId: params.runId,
    mode: params.cfg.capture.mode,
    includeAssistant: captureFromAssistant,
    maxItemsPerRun: params.cfg.capture.maxItemsPerRun,
    totalMessages: normalized.length,
    eligibleMessages: candidatesInput.length,
    heuristicCandidates: heuristic.length,
  });

  if (params.cfg.capture.mode === "local") {
    params.log.debug("memory_braid.capture.mode", {
      runId: params.runId,
      mode: params.cfg.capture.mode,
      decision: "heuristic_only",
      candidates: heuristic.length,
    });
    return heuristic;
  }

  if (!params.cfg.capture.ml.provider || !params.cfg.capture.ml.model) {
    params.log.warn("memory_braid.capture.ml", {
      runId: params.runId,
      reason: "missing_provider_or_model",
      mode: params.cfg.capture.mode,
      hasProvider: Boolean(params.cfg.capture.ml.provider),
      hasModel: Boolean(params.cfg.capture.ml.model),
      fallback: "heuristic",
      candidates: heuristic.length,
    });
    return heuristic;
  }

  try {
    if (params.cfg.capture.mode === "hybrid") {
      if (heuristic.length === 0) {
        params.log.debug("memory_braid.capture.ml", {
          runId: params.runId,
          mode: params.cfg.capture.mode,
          provider: params.cfg.capture.ml.provider,
          model: params.cfg.capture.ml.model,
          decision: "skip_ml_enrichment_no_heuristic_candidates",
        });
        return heuristic;
      }

      const ml = await callMlEnrichment({
        provider: params.cfg.capture.ml.provider,
        model: params.cfg.capture.ml.model,
        timeoutMs: params.cfg.capture.ml.timeoutMs,
        candidates: heuristic,
      });
      const enriched = applyMlResult(heuristic, ml);
      params.log.debug("memory_braid.capture.ml", {
        runId: params.runId,
        mode: params.cfg.capture.mode,
        provider: params.cfg.capture.ml.provider,
        model: params.cfg.capture.ml.model,
        requested: heuristic.length,
        returned: ml.length,
        enriched: enriched.length,
        fallbackUsed: ml.length === 0,
      });
      return enriched;
    }

    const mlExtractedRaw = await callMlExtraction({
      provider: params.cfg.capture.ml.provider,
      model: params.cfg.capture.ml.model,
      timeoutMs: params.cfg.capture.ml.timeoutMs,
      maxItems: params.cfg.capture.maxItemsPerRun,
      messages: candidatesInput,
    });
    const mlExtracted = applyMlExtractionResult(mlExtractedRaw, params.cfg.capture.maxItemsPerRun);
    params.log.debug("memory_braid.capture.ml", {
      runId: params.runId,
      mode: params.cfg.capture.mode,
      provider: params.cfg.capture.ml.provider,
      model: params.cfg.capture.ml.model,
      returned: mlExtractedRaw.length,
      extracted: mlExtracted.length,
      fallbackUsed: mlExtracted.length === 0,
    });
    return mlExtracted.length > 0 ? mlExtracted : heuristic;
  } catch (err) {
    params.log.warn("memory_braid.capture.ml", {
      runId: params.runId,
      mode: params.cfg.capture.mode,
      error: err instanceof Error ? err.message : String(err),
      fallback: "heuristic",
      candidates: heuristic.length,
    });
    return heuristic;
  }
}

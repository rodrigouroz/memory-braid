import { normalizeForHash, normalizeWhitespace, sha256 } from "./chunking.js";
import type {
  AssembledCaptureInput,
  CaptureInputMessage,
  PendingInboundTurn,
} from "./types.js";

type NormalizedHookMessage = {
  role: string;
  text: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function extractStructuredTextCandidate(value: unknown, depth = 0): string {
  if (depth > 5) {
    return "";
  }
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractStructuredTextCandidate(entry, depth + 1))
      .filter(Boolean);
    return normalizeWhitespace(parts.join(" "));
  }

  const record = value as Record<string, unknown>;
  const directText = typeof record.text === "string" ? normalizeWhitespace(record.text) : "";
  if (directText) {
    return directText;
  }
  const caption = typeof record.caption === "string" ? normalizeWhitespace(record.caption) : "";
  if (caption) {
    return caption;
  }

  const nestedCandidates = [
    record.message,
    record.data,
    record.payload,
    record.update,
    record.edited_message,
    record.channel_post,
    record.callback_query,
  ];
  for (const candidate of nestedCandidates) {
    const extracted = extractStructuredTextCandidate(candidate, depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

export function extractStructuredTextFromString(content: string): string | undefined {
  const normalized = normalizeWhitespace(content);
  if (!normalized || !/^[{\[]/.test(normalized)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    const extracted = extractStructuredTextCandidate(parsed);
    return extracted || undefined;
  } catch {
    return undefined;
  }
}

export function extractHookMessageText(content: unknown): string {
  if (typeof content === "string") {
    return extractStructuredTextFromString(content) ?? normalizeWhitespace(content);
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
      const normalized =
        extractStructuredTextFromString(item.text) ?? normalizeWhitespace(item.text);
      if (normalized) {
        parts.push(normalized);
      }
    }
  }
  return parts.join(" ");
}

export function normalizeHookMessages(messages: unknown[]): NormalizedHookMessage[] {
  const out: NormalizedHookMessage[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const direct = entry as { role?: unknown; content?: unknown };
    if (typeof direct.role === "string") {
      const text = extractHookMessageText(direct.content);
      if (text) {
        out.push({ role: direct.role, text });
      }
      continue;
    }

    const wrapped = entry as { message?: { role?: unknown; content?: unknown } };
    if (wrapped.message && typeof wrapped.message.role === "string") {
      const text = extractHookMessageText(wrapped.message.content);
      if (text) {
        out.push({ role: wrapped.message.role, text });
      }
    }
  }
  return out;
}

function normalizeProvenanceKind(value: unknown): string | undefined {
  const record = asRecord(value);
  const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  return kind || undefined;
}

export function getPendingInboundTurn(message: unknown): PendingInboundTurn | undefined {
  const record = asRecord(message);
  const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
  const provenanceKind = normalizeProvenanceKind(record.provenance);
  if (role !== "user" || provenanceKind !== "external_user") {
    return undefined;
  }

  const text = extractHookMessageText(record.content);
  if (!text) {
    return undefined;
  }

  return {
    text,
    messageHash: sha256(normalizeForHash(text)),
    receivedAt: Date.now(),
  };
}

function buildCaptureInputMessage(
  role: "user" | "assistant",
  origin: "external_user" | "assistant_derived",
  text: string,
): CaptureInputMessage {
  return {
    role,
    origin,
    text,
    messageHash: sha256(normalizeForHash(text)),
  };
}

export function assembleCaptureInput(params: {
  messages: unknown[];
  includeAssistant: boolean;
  pendingInboundTurn?: PendingInboundTurn;
}): AssembledCaptureInput | undefined {
  const normalized = normalizeHookMessages(params.messages);
  const lastUserIndex = (() => {
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      if (normalized[i]?.role === "user") {
        return i;
      }
    }
    return -1;
  })();

  const userText = params.pendingInboundTurn?.text ?? normalized[lastUserIndex]?.text ?? "";
  if (!userText) {
    return undefined;
  }

  const assembled: CaptureInputMessage[] = [
    buildCaptureInputMessage("user", "external_user", userText),
  ];

  if (params.includeAssistant) {
    const assistantStart = lastUserIndex >= 0 ? lastUserIndex + 1 : normalized.length;
    for (let i = assistantStart; i < normalized.length; i += 1) {
      const message = normalized[i];
      if (!message || message.role !== "assistant" || !message.text) {
        continue;
      }
      assembled.push(buildCaptureInputMessage("assistant", "assistant_derived", message.text));
    }
  }

  const hashInput = assembled.map((message) => message.messageHash).join("|");
  return {
    messages: assembled,
    capturePath: params.pendingInboundTurn ? "before_message_write" : "agent_end_last_turn",
    turnHash: sha256(hashInput),
    fallbackUsed: !params.pendingInboundTurn,
  };
}

function tokenize(text: string): Set<string> {
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const token of tokens) {
    const normalized = token
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "");
    if (normalized.length >= 3) {
      out.add(normalized);
    }
  }
  return out;
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.max(left.size, right.size);
}

export function matchCandidateToCaptureInput(
  candidateText: string,
  messages: CaptureInputMessage[],
): CaptureInputMessage | undefined {
  const candidateHash = sha256(normalizeForHash(candidateText));
  for (const message of messages) {
    if (message.messageHash === candidateHash) {
      return message;
    }
  }

  const candidateTokens = tokenize(candidateText);
  let bestMatch: CaptureInputMessage | undefined;
  let bestScore = 0;

  for (const message of messages) {
    const score = overlapRatio(candidateTokens, tokenize(message.text));
    if (score > bestScore) {
      bestScore = score;
      bestMatch = message;
    }
  }

  return bestScore >= 0.24 ? bestMatch : undefined;
}

const ROLE_PREFIX_LINE = /^(?:assistant|system|developer|tool|user|human|bot|ai|agent)\s*:/i;
const INLINE_ROLE_LABEL = /\b(?:assistant|system|developer|tool|user)\s*:/gi;
const STRUCTURED_METADATA_KEY =
  /^\s*["']?(?:message_id|reply_to_id|sender_id|sender|timestamp|thread|conversation|channel|metadata)\b/i;

export function isLikelyTranscriptLikeText(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }

  const rolePrefixedLines = lines.filter((line) => ROLE_PREFIX_LINE.test(line)).length;
  const inlineRoleLabels = normalized.match(INLINE_ROLE_LABEL)?.length ?? 0;
  const fencedBlocks = normalized.match(/```/g)?.length ?? 0;
  const metadataLines = lines.filter((line) => STRUCTURED_METADATA_KEY.test(line)).length;

  if (rolePrefixedLines >= 2) {
    return true;
  }
  if (inlineRoleLabels >= 3) {
    return true;
  }
  if (fencedBlocks >= 2 && metadataLines >= 2) {
    return true;
  }
  return metadataLines >= 4 && lines.length >= 6;
}

export function isOversizedAtomicMemory(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  const lines = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return normalized.length > 1600 || lines.length > 18;
}

const RECAP_PREFIXES = [
  /^the user\b/i,
  /^user\b/i,
  /^usuario\b/i,
  /^in this (?:turn|conversation)\b/i,
  /^(?:we|i) (?:discussed|talked about|went over|covered)\b/i,
  /^(?:summary|recap)\b/i,
];

const TEMPORAL_REFERENCE_PATTERN =
  /\b(?:today|tomorrow|yesterday|this turn|this session|earlier in this session|just now|in this chat)\b/i;

export function isLikelyTurnRecap(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }
  if (normalized.length > 260 && /\b(?:asked|wanted|needed|said|requested)\b/i.test(normalized)) {
    return true;
  }
  return RECAP_PREFIXES.some((pattern) => pattern.test(normalized));
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);
}

function looksReusableLearning(text: string): boolean {
  if (text.length < 24 || text.length > 220) {
    return false;
  }
  if (TEMPORAL_REFERENCE_PATTERN.test(text)) {
    return false;
  }
  if (isLikelyTranscriptLikeText(text) || isLikelyTurnRecap(text)) {
    return false;
  }
  return /\b(?:prefer|avoid|use|keep|store|remember|dedupe|inject|search|persist|reject|limit|filter|only|always|never|when)\b/i.test(
    text,
  );
}

export function compactAgentLearning(text: string): string | undefined {
  const normalized = normalizeWhitespace(text);
  if (!normalized || isOversizedAtomicMemory(normalized) || isLikelyTranscriptLikeText(normalized)) {
    return undefined;
  }
  if (looksReusableLearning(normalized)) {
    return normalized;
  }

  const sentences = splitIntoSentences(normalized);
  for (const sentence of sentences) {
    if (looksReusableLearning(sentence)) {
      return sentence;
    }
  }

  return undefined;
}

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

export function extractHookMessageText(content: unknown): string {
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

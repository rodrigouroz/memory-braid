import { normalizeWhitespace } from "./chunking.js";
import {
  isLikelyTranscriptLikeText,
  isLikelyTurnRecap,
} from "./capture.js";
import {
  primaryTaxonomyAnchor,
  taxonomyTerms,
} from "./memory-model.js";
import type {
  MemoryBraidConfig,
} from "./config.js";
import type {
  MemoryKind,
  MemorySelectionDecision,
  TaxonomyBuckets,
} from "./types.js";

type SelectionResult = {
  decision: MemorySelectionDecision;
  score: number;
  reasons: string[];
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pushReason(reasons: string[], condition: boolean, reason: string): void {
  if (condition) {
    reasons.push(reason);
  }
}

function stableSignal(text: string): boolean {
  return /\b(?:prefer|timezone|name is|works at|work at|team|organization|project|repo|workspace|we decided|decision|we will|we use|deploy|stack|tooling)\b/i.test(
    text,
  );
}

function explicitRememberSignal(text: string): boolean {
  return /^(?:remember|note)\b/i.test(text);
}

function volatileSignal(text: string): boolean {
  return /\b(?:today|tomorrow|yesterday|later today|this afternoon|tonight|this week|next week|this session|this chat|just now|one-off)\b/i.test(
    text,
  );
}

function recurringTaskSignal(text: string): boolean {
  return /\b(?:every|weekly|monthly|each|recurring|routine|regularly)\b/i.test(text);
}

function firstPersonOwnershipSignal(text: string): boolean {
  return /\b(?:my|i prefer|i like|i use|we decided|our|we use)\b/i.test(text);
}

function thresholdForKind(cfg: MemoryBraidConfig, kind: MemoryKind): number {
  if (kind === "preference" || kind === "decision") {
    return cfg.capture.selection.minPreferenceDecisionScore;
  }
  if (kind === "fact") {
    return cfg.capture.selection.minFactScore;
  }
  if (kind === "task") {
    return cfg.capture.selection.minTaskScore;
  }
  return cfg.capture.selection.minOtherScore;
}

export function scoreObservedMemory(params: {
  text: string;
  kind: MemoryKind;
  extractionScore: number;
  taxonomy: TaxonomyBuckets;
  source: "heuristic" | "ml";
  cfg: MemoryBraidConfig;
}): SelectionResult {
  const text = normalizeWhitespace(params.text);
  const reasons: string[] = [];
  if (!text || isLikelyTranscriptLikeText(text) || isLikelyTurnRecap(text)) {
    return {
      decision: "ignore",
      score: 0,
      reasons: ["invalid_or_recap"],
    };
  }

  let score = clampScore(params.extractionScore) * 0.45;
  const taxonomyCount = taxonomyTerms(params.taxonomy).length;
  const hasAnchor = Boolean(primaryTaxonomyAnchor(params.taxonomy));

  if (params.kind === "preference") {
    score += 0.22;
    reasons.push("kind:preference");
  } else if (params.kind === "decision") {
    score += 0.2;
    reasons.push("kind:decision");
  } else if (params.kind === "fact") {
    score += 0.14;
    reasons.push("kind:fact");
  } else if (params.kind === "task") {
    score += 0.04;
    reasons.push("kind:task");
  }

  pushReason(reasons, explicitRememberSignal(text), "explicit_remember");
  if (explicitRememberSignal(text)) {
    score += 0.06;
  }
  pushReason(reasons, stableSignal(text), "stable_signal");
  if (stableSignal(text)) {
    score += 0.12;
  }
  pushReason(reasons, firstPersonOwnershipSignal(text), "first_person");
  if (firstPersonOwnershipSignal(text)) {
    score += 0.08;
  }
  pushReason(reasons, hasAnchor, "taxonomy_anchor");
  if (hasAnchor) {
    score += 0.08;
  }
  if (taxonomyCount >= 2) {
    score += 0.04;
    reasons.push("taxonomy_rich");
  }
  if (params.source === "ml") {
    reasons.push("ml_extracted");
  }
  pushReason(reasons, volatileSignal(text), "volatile_signal");
  if (volatileSignal(text)) {
    score -= 0.35;
  }
  if (params.kind === "task" && !recurringTaskSignal(text)) {
    score -= 0.2;
    reasons.push("one_off_task_penalty");
  }
  if (params.kind === "other") {
    score -= 0.18;
    reasons.push("kind:other_penalty");
  }

  const finalScore = clampScore(score);
  return {
    decision: finalScore >= thresholdForKind(params.cfg, params.kind) ? "episodic" : "ignore",
    score: finalScore,
    reasons,
  };
}

export function scoreProceduralMemory(params: {
  text: string;
  confidence?: number;
  captureIntent: "explicit_tool" | "self_reflection";
  cfg: MemoryBraidConfig;
}): SelectionResult {
  const text = normalizeWhitespace(params.text);
  const reasons: string[] = [];
  if (!text || isLikelyTranscriptLikeText(text) || isLikelyTurnRecap(text)) {
    return {
      decision: "ignore",
      score: 0,
      reasons: ["invalid_or_recap"],
    };
  }

  let score = clampScore(params.confidence ?? 0.65) * 0.4;
  if (/\b(?:always|never|prefer|avoid|use|keep|store|limit|filter|dedupe|search|persist|only|when|if|strategy|approach|plan)\b/i.test(text)) {
    score += 0.3;
    reasons.push("reusable_procedure");
  }
  if (params.captureIntent === "explicit_tool") {
    score += 0.12;
    reasons.push("explicit_tool");
  } else {
    score += 0.05;
    reasons.push("self_reflection");
  }
  if (text.length >= 32 && text.length <= 220) {
    score += 0.08;
    reasons.push("compact_atomic");
  }
  if (volatileSignal(text)) {
    score -= 0.35;
    reasons.push("volatile_signal");
  }

  const finalScore = clampScore(score);
  return {
    decision: finalScore >= params.cfg.capture.selection.minProceduralScore ? "procedural" : "ignore",
    score: finalScore,
    reasons,
  };
}

export function scoreSemanticPromotion(params: {
  kind: MemoryKind;
  supportCount: number;
  recallSupport: number;
  taxonomy: TaxonomyBuckets;
  firstSeenAt: number;
  lastSeenAt: number;
  sessionKeys: Set<string>;
  text: string;
  cfg: MemoryBraidConfig;
}): SelectionResult {
  const reasons: string[] = [];
  let score = 0;
  score += Math.min(0.4, Math.max(0, params.supportCount - 1) * 0.18);
  if (params.supportCount > 1) {
    reasons.push("repeated_support");
  }
  score += Math.min(0.18, params.recallSupport * 0.06);
  if (params.recallSupport > 0) {
    reasons.push("recall_reinforced");
  }
  if (params.sessionKeys.size > 1) {
    score += 0.14;
    reasons.push("cross_session");
  }
  const ageDays = Math.max(0, (params.lastSeenAt - params.firstSeenAt) / (24 * 60 * 60 * 1000));
  if (ageDays >= 1) {
    score += Math.min(0.12, ageDays / 14);
    reasons.push("survived_over_time");
  }
  if (params.kind === "preference" || params.kind === "decision" || params.kind === "fact") {
    score += 0.1;
    reasons.push(`kind:${params.kind}`);
  } else if (params.kind === "task" || params.kind === "other") {
    score -= 0.12;
    reasons.push(`kind:${params.kind}_penalty`);
  }
  if (primaryTaxonomyAnchor(params.taxonomy)) {
    score += 0.08;
    reasons.push("taxonomy_anchor");
  }
  if (taxonomyTerms(params.taxonomy).length >= 2) {
    score += 0.04;
    reasons.push("taxonomy_rich");
  }
  if (volatileSignal(params.text) && params.kind !== "preference" && params.kind !== "decision") {
    score -= 0.18;
    reasons.push("volatile_signal");
  }

  const finalScore = clampScore(score);
  return {
    decision: finalScore >= params.cfg.consolidation.minSelectionScore ? "semantic" : "ignore",
    score: finalScore,
    reasons,
  };
}

export function summarizeSelection(result: SelectionResult): string {
  return `${result.decision} score=${result.score.toFixed(2)} reasons=${result.reasons.join(",") || "n/a"}`;
}

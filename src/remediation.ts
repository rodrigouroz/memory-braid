import { normalizeWhitespace } from "./chunking.js";
import { isLikelyTranscriptLikeText, isOversizedAtomicMemory } from "./capture.js";
import type { MemoryBraidResult, RemediationState } from "./types.js";

export type RemediationAction = "audit" | "quarantine" | "delete" | "purge-all-captured";

export type AuditReason =
  | "legacy_capture_missing_provenance"
  | "invalid_capture_metadata"
  | "transcript_like_content"
  | "oversized_capture_content";

export type AuditRecord = {
  memory: MemoryBraidResult;
  sourceType: string;
  captureOrigin?: string;
  pluginCaptureVersion?: string;
  quarantined: boolean;
  quarantineReason?: string;
  suspiciousReasons: AuditReason[];
};

export type AuditSummary = {
  total: number;
  captured: number;
  suspicious: number;
  quarantined: number;
  bySourceType: Record<string, number>;
  byCaptureOrigin: Record<string, number>;
  byPluginVersion: Record<string, number>;
  suspiciousByReason: Record<AuditReason, number>;
  samples: Array<{
    id?: string;
    reasons: AuditReason[];
    snippet: string;
  }>;
  records: AuditRecord[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isKnownCaptureOrigin(value: string | undefined): boolean {
  return value === "external_user" || value === "assistant_derived";
}

function isKnownCapturePath(value: string | undefined): boolean {
  return value === "before_message_write" || value === "agent_end_last_turn";
}

export function isQuarantinedMemory(
  record: MemoryBraidResult,
  remediationState?: RemediationState,
): { quarantined: boolean; reason?: string } {
  const metadata = asRecord(record.metadata);
  const local = record.id ? remediationState?.quarantined?.[record.id] : undefined;
  if (local) {
    return {
      quarantined: true,
      reason: local.reason,
    };
  }

  const status = asString(metadata.remediationStatus);
  const quarantinedAt = asString(metadata.quarantinedAt);
  if (status === "quarantined" || quarantinedAt) {
    return {
      quarantined: true,
      reason: asString(metadata.quarantineReason),
    };
  }

  return { quarantined: false };
}

export function buildQuarantineMetadata(
  metadata: Record<string, unknown> | undefined,
  reason: string,
  quarantinedAt: string,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    remediationStatus: "quarantined",
    quarantinedAt,
    quarantineReason: reason,
  };
}

export function clearQuarantineMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next.remediationStatus;
  delete next.quarantinedAt;
  delete next.quarantineReason;
  return next;
}

export function analyzeMemoryRecord(
  memory: MemoryBraidResult,
  remediationState?: RemediationState,
): AuditRecord {
  const metadata = asRecord(memory.metadata);
  const sourceType = asString(metadata.sourceType) ?? "unknown";
  const captureOrigin = asString(metadata.captureOrigin);
  const capturePath = asString(metadata.capturePath);
  const pluginCaptureVersion = asString(metadata.pluginCaptureVersion);
  const suspiciousReasons: AuditReason[] = [];
  const snippet = normalizeWhitespace(memory.snippet);

  if (sourceType === "capture") {
    const missingProvenance =
      !captureOrigin || !pluginCaptureVersion || !capturePath;
    if (missingProvenance) {
      suspiciousReasons.push("legacy_capture_missing_provenance");
    } else if (!isKnownCaptureOrigin(captureOrigin) || !isKnownCapturePath(capturePath)) {
      suspiciousReasons.push("invalid_capture_metadata");
    }

    if (isLikelyTranscriptLikeText(snippet)) {
      suspiciousReasons.push("transcript_like_content");
    }
    if (isOversizedAtomicMemory(snippet)) {
      suspiciousReasons.push("oversized_capture_content");
    }
  }

  const quarantine = isQuarantinedMemory(memory, remediationState);
  return {
    memory,
    sourceType,
    captureOrigin,
    pluginCaptureVersion,
    quarantined: quarantine.quarantined,
    quarantineReason: quarantine.reason,
    suspiciousReasons: Array.from(new Set(suspiciousReasons)),
  };
}

export function buildAuditSummary(params: {
  records: MemoryBraidResult[];
  remediationState?: RemediationState;
  sampleLimit?: number;
}): AuditSummary {
  const bySourceType: Record<string, number> = {};
  const byCaptureOrigin: Record<string, number> = {};
  const byPluginVersion: Record<string, number> = {};
  const suspiciousByReason: Record<AuditReason, number> = {
    legacy_capture_missing_provenance: 0,
    invalid_capture_metadata: 0,
    transcript_like_content: 0,
    oversized_capture_content: 0,
  };

  const analyzed = params.records.map((record) => analyzeMemoryRecord(record, params.remediationState));
  for (const record of analyzed) {
    bySourceType[record.sourceType] = (bySourceType[record.sourceType] ?? 0) + 1;
    if (record.captureOrigin) {
      byCaptureOrigin[record.captureOrigin] = (byCaptureOrigin[record.captureOrigin] ?? 0) + 1;
    } else if (record.sourceType === "capture") {
      byCaptureOrigin["missing"] = (byCaptureOrigin.missing ?? 0) + 1;
    }

    if (record.pluginCaptureVersion) {
      byPluginVersion[record.pluginCaptureVersion] =
        (byPluginVersion[record.pluginCaptureVersion] ?? 0) + 1;
    } else if (record.sourceType === "capture") {
      byPluginVersion["missing"] = (byPluginVersion.missing ?? 0) + 1;
    }

    for (const reason of record.suspiciousReasons) {
      suspiciousByReason[reason] += 1;
    }
  }

  const suspiciousRecords = analyzed.filter((record) => record.suspiciousReasons.length > 0);
  const sampleLimit = Math.max(1, params.sampleLimit ?? 5);
  return {
    total: analyzed.length,
    captured: analyzed.filter((record) => record.sourceType === "capture").length,
    suspicious: suspiciousRecords.length,
    quarantined: analyzed.filter((record) => record.quarantined).length,
    bySourceType,
    byCaptureOrigin,
    byPluginVersion,
    suspiciousByReason,
    samples: suspiciousRecords.slice(0, sampleLimit).map((record) => ({
      id: record.memory.id,
      reasons: record.suspiciousReasons,
      snippet: record.memory.snippet,
    })),
    records: analyzed,
  };
}

export function selectRemediationTargets(
  summary: AuditSummary,
  action: RemediationAction,
): AuditRecord[] {
  if (action === "purge-all-captured") {
    return summary.records.filter((record) => record.sourceType === "capture");
  }
  if (action === "audit") {
    return [];
  }
  return summary.records.filter(
    (record) =>
      record.sourceType === "capture" &&
      record.suspiciousReasons.length > 0 &&
      Boolean(record.memory.id),
  );
}

function formatCounts(label: string, counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) {
    return [`${label}: n/a`];
  }
  return [`${label}:`, ...entries.map(([key, value]) => `- ${key}: ${value}`)];
}

export function formatAuditSummary(summary: AuditSummary): string {
  const lines = [
    "Memory Braid remediation audit",
    `- total: ${summary.total}`,
    `- captured: ${summary.captured}`,
    `- suspicious: ${summary.suspicious}`,
    `- quarantined: ${summary.quarantined}`,
    ...formatCounts("By sourceType", summary.bySourceType),
    ...formatCounts("By captureOrigin", summary.byCaptureOrigin),
    ...formatCounts("By pluginCaptureVersion", summary.byPluginVersion),
    ...formatCounts("Suspicious by reason", summary.suspiciousByReason),
  ];

  if (summary.samples.length > 0) {
    lines.push("Samples:");
    for (const sample of summary.samples) {
      lines.push(
        `- ${sample.id ?? "unknown"} [${sample.reasons.join(", ")}] ${normalizeWhitespace(sample.snippet).slice(0, 140)}`,
      );
    }
  }

  return lines.join("\n");
}

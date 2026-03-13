import { normalizeWhitespace } from "./chunking.js";
import type { ExtractedEntity } from "./entities.js";
import type {
  MemoryBraidResult,
  MemoryKind,
  MemoryLayer,
  MemoryOwner,
  TaxonomyBuckets,
} from "./types.js";

const TOPIC_STOPWORDS = new Set([
  "about",
  "after",
  "agent",
  "always",
  "before",
  "from",
  "have",
  "into",
  "just",
  "keep",
  "like",
  "memory",
  "never",
  "note",
  "only",
  "remember",
  "that",
  "their",
  "them",
  "they",
  "this",
  "turn",
  "user",
  "using",
  "what",
  "when",
  "will",
  "with",
]);

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeMemoryKind(raw: unknown): MemoryKind | undefined {
  return raw === "fact" ||
    raw === "preference" ||
    raw === "decision" ||
    raw === "task" ||
    raw === "heuristic" ||
    raw === "lesson" ||
    raw === "strategy" ||
    raw === "other"
    ? raw
    : undefined;
}

export function normalizeMemoryOwner(raw: unknown): MemoryOwner | undefined {
  return raw === "user" || raw === "agent" ? raw : undefined;
}

export function normalizeMemoryLayer(raw: unknown): MemoryLayer | undefined {
  return raw === "episodic" || raw === "semantic" || raw === "procedural" ? raw : undefined;
}

export function emptyTaxonomy(): TaxonomyBuckets {
  return {
    people: [],
    places: [],
    organizations: [],
    projects: [],
    tools: [],
    topics: [],
  };
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pushBucket(target: string[], value: string): void {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) {
    return;
  }
  const existing = new Set(target.map((entry) => slugify(entry)));
  const key = slugify(cleaned);
  if (!key || existing.has(key)) {
    return;
  }
  target.push(cleaned);
}

function firstWords(text: string, count: number): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count)
    .join(" ");
}

function normalizeEntityRows(raw: unknown): ExtractedEntity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ExtractedEntity[] = [];
  for (const value of raw) {
    const row = asRecord(value);
    const text = asString(row.text);
    const type = asString(row.type);
    const canonicalUri = asString(row.canonicalUri);
    if (!text || !type || !canonicalUri) {
      continue;
    }
    if (type !== "person" && type !== "organization" && type !== "location" && type !== "misc") {
      continue;
    }
    out.push({
      text,
      type,
      score:
        typeof row.score === "number" && Number.isFinite(row.score)
          ? Math.max(0, Math.min(1, row.score))
          : 0,
      canonicalUri,
    });
  }
  return out;
}

function deriveToolCandidates(text: string): string[] {
  const matches = [
    ...text.matchAll(/`([^`]{2,40})`/g),
    ...text.matchAll(/\b(?:use|using|with|tool|library|framework)\s+([A-Z][A-Za-z0-9._-]{1,40})/g),
  ];
  return matches.map((match) => normalizeWhitespace(match[1] ?? "")).filter(Boolean);
}

function deriveProjectCandidates(text: string): string[] {
  const matches = [
    ...text.matchAll(/\bproject\s+([A-Z][A-Za-z0-9._-]{1,50})/gi),
    ...text.matchAll(/\b(?:repo|workspace)\s+([A-Z][A-Za-z0-9._-]{1,50})/gi),
  ];
  return matches.map((match) => normalizeWhitespace(match[1] ?? "")).filter(Boolean);
}

function deriveTopicCandidates(text: string): string[] {
  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const normalized = slugify(token);
    if (!normalized || TOPIC_STOPWORDS.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(token);
    if (out.length >= 3) {
      break;
    }
  }
  return out;
}

export function buildTaxonomy(params: {
  text: string;
  entities?: unknown;
  existingTaxonomy?: unknown;
}): TaxonomyBuckets {
  const taxonomy = normalizeTaxonomy(params.existingTaxonomy);
  for (const entity of normalizeEntityRows(params.entities)) {
    if (entity.type === "person") {
      pushBucket(taxonomy.people, entity.text);
    } else if (entity.type === "organization") {
      pushBucket(taxonomy.organizations, entity.text);
    } else if (entity.type === "location") {
      pushBucket(taxonomy.places, entity.text);
    }
  }

  for (const candidate of deriveToolCandidates(params.text)) {
    pushBucket(taxonomy.tools, candidate);
  }
  for (const candidate of deriveProjectCandidates(params.text)) {
    pushBucket(taxonomy.projects, candidate);
  }
  for (const candidate of deriveTopicCandidates(params.text)) {
    pushBucket(taxonomy.topics, candidate);
  }

  return taxonomy;
}

export function normalizeTaxonomy(raw: unknown): TaxonomyBuckets {
  const source = asRecord(raw);
  const out = emptyTaxonomy();
  const keys = Object.keys(out) as Array<keyof TaxonomyBuckets>;
  for (const key of keys) {
    const values = Array.isArray(source[key]) ? source[key] : [];
    for (const value of values) {
      if (typeof value === "string") {
        pushBucket(out[key], value);
      }
    }
  }
  return out;
}

export function taxonomyTerms(taxonomy: TaxonomyBuckets): string[] {
  return [
    ...taxonomy.people,
    ...taxonomy.places,
    ...taxonomy.organizations,
    ...taxonomy.projects,
    ...taxonomy.tools,
    ...taxonomy.topics,
  ];
}

export function taxonomyOverlap(left: TaxonomyBuckets, right: TaxonomyBuckets): number {
  const leftTerms = new Set(taxonomyTerms(left).map(slugify));
  const rightTerms = new Set(taxonomyTerms(right).map(slugify));
  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      shared += 1;
    }
  }
  return shared / Math.max(leftTerms.size, rightTerms.size);
}

export function primaryTaxonomyAnchor(taxonomy: TaxonomyBuckets): string | undefined {
  return (
    taxonomy.people[0] ??
    taxonomy.organizations[0] ??
    taxonomy.projects[0] ??
    taxonomy.tools[0] ??
    taxonomy.topics[0] ??
    taxonomy.places[0]
  );
}

export function formatTaxonomySummary(taxonomy: TaxonomyBuckets): string {
  const lines: string[] = [];
  const ordered: Array<keyof TaxonomyBuckets> = [
    "people",
    "places",
    "organizations",
    "projects",
    "tools",
    "topics",
  ];
  for (const key of ordered) {
    if (taxonomy[key].length > 0) {
      lines.push(`${key}=${taxonomy[key].join(", ")}`);
    }
  }
  return lines.join(" | ");
}

export function inferMemoryLayer(result: MemoryBraidResult): MemoryLayer {
  const metadata = asRecord(result.metadata);
  const explicit = normalizeMemoryLayer(metadata.memoryLayer);
  if (explicit) {
    return explicit;
  }
  const sourceType = asString(metadata.sourceType);
  if (sourceType === "capture") {
    return "episodic";
  }
  if (sourceType === "agent_learning") {
    return "procedural";
  }
  if (sourceType === "compendium") {
    return "semantic";
  }
  const owner = normalizeMemoryOwner(metadata.memoryOwner);
  if (owner === "agent") {
    return "procedural";
  }
  return "episodic";
}

export function summarizeSnippet(text: string, maxChars = 140): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

export function stripCapturePreamble(text: string): string {
  const normalized = normalizeWhitespace(text);
  return normalized.replace(/^(?:remember that|note that|we discussed that)\s+/i, "");
}

export function summarizeClusterText(texts: string[], kind?: MemoryKind): string {
  const latest = stripCapturePreamble(texts[texts.length - 1] ?? "");
  const base = latest || stripCapturePreamble(texts[0] ?? "");
  if (!base) {
    return "";
  }
  if (kind === "preference") {
    return `Preference: ${firstWords(base, 24)}`;
  }
  if (kind === "decision") {
    return `Decision: ${firstWords(base, 24)}`;
  }
  if (kind === "fact") {
    return `Fact: ${firstWords(base, 24)}`;
  }
  if (kind === "task") {
    return `Recurring task context: ${firstWords(base, 24)}`;
  }
  return firstWords(base, 28);
}

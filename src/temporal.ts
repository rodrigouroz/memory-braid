import * as chrono from "chrono-node";
import { normalizeWhitespace } from "./chunking.js";
import { asRecord, asString } from "./memory-model.js";
import type { MemoryBraidResult } from "./types.js";

const SPANISH_MONTH_MAP: Record<string, string> = {
  enero: "January",
  febrero: "February",
  marzo: "March",
  abril: "April",
  mayo: "May",
  junio: "June",
  julio: "July",
  agosto: "August",
  septiembre: "September",
  setiembre: "September",
  octubre: "October",
  noviembre: "November",
  diciembre: "December",
};

const MONTH_INDEX_BY_ENGLISH: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export type TimeRange = {
  startMs: number;
  endMs: number;
  startDate: string;
  endDate: string;
  label: string;
  matchedText?: string;
};

type NormalizedQuery = {
  normalizedMatchedText?: string;
  matchedOriginalText?: string;
  explicitYear: boolean;
  monthLevel: boolean;
};

function monthRange(year: number, monthIndex: number): TimeRange {
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    label: `${start.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${year}`,
  };
}

function cleanQueryAfterTimeRemoval(query: string): string {
  return normalizeWhitespace(query).replace(/\s+([?.!,;:])/g, "$1");
}

function explicitRange(start: string, end: string): TimeRange | undefined {
  const startDate = Date.parse(`${start}T00:00:00.000Z`);
  const endDate = Date.parse(`${end}T23:59:59.999Z`);
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate) || endDate < startDate) {
    return undefined;
  }
  return {
    startMs: startDate,
    endMs: endDate,
    startDate: new Date(startDate).toISOString().slice(0, 10),
    endDate: new Date(endDate).toISOString().slice(0, 10),
    label: `${start}..${end}`,
  };
}

function normalizeSpanishMonthPhrase(query: string): NormalizedQuery | undefined {
  const relativeMonth = /\b(?:este mes)\b/i.exec(query);
  if (relativeMonth) {
    return {
      normalizedMatchedText: "this month",
      matchedOriginalText: relativeMonth[0],
      explicitYear: false,
      monthLevel: true,
    };
  }

  const lastMonth = /\b(?:el\s+mes\s+pasado|mes\s+pasado)\b/i.exec(query);
  if (lastMonth) {
    return {
      normalizedMatchedText: "last month",
      matchedOriginalText: lastMonth[0],
      explicitYear: false,
      monthLevel: true,
    };
  }

  const byMonth = /\ben\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del))?(?:\s+(\d{4}))?\b/i.exec(
    query,
  );
  if (!byMonth) {
    return undefined;
  }
  const englishMonth = SPANISH_MONTH_MAP[byMonth[1].toLowerCase()];
  if (!englishMonth) {
    return undefined;
  }
  const replacement = byMonth[2] ? `in ${englishMonth} ${byMonth[2]}` : `in ${englishMonth}`;
  return {
    normalizedMatchedText: replacement,
    matchedOriginalText: byMonth[0],
    explicitYear: Boolean(byMonth[2]),
    monthLevel: true,
  };
}

function normalizeTimeQuery(query: string): NormalizedQuery {
  const normalized = normalizeWhitespace(query);
  const spanish = normalizeSpanishMonthPhrase(normalized);
  if (spanish) {
    return spanish;
  }

  const englishMonth = /\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/i.exec(
    normalized,
  );
  if (englishMonth) {
    return {
      normalizedMatchedText: englishMonth[0],
      matchedOriginalText: englishMonth[0],
      explicitYear: Boolean(englishMonth[2]),
      monthLevel: true,
    };
  }

  const thisMonth = /\bthis month\b/i.exec(normalized);
  if (thisMonth) {
    return {
      normalizedMatchedText: thisMonth[0],
      matchedOriginalText: thisMonth[0],
      explicitYear: false,
      monthLevel: true,
    };
  }

  const lastMonth = /\blast month\b/i.exec(normalized);
  if (lastMonth) {
    return {
      normalizedMatchedText: lastMonth[0],
      matchedOriginalText: lastMonth[0],
      explicitYear: false,
      monthLevel: true,
    };
  }

  return {
    explicitYear: false,
    monthLevel: false,
  };
}

function inferMonthRangeFromChrono(params: {
  result: chrono.ParsingResult;
  matchedText?: string;
  detectionText?: string;
  explicitYear: boolean;
  now: Date;
}): TimeRange | undefined {
  const parsedDate = params.result.start?.date();
  if (!parsedDate) {
    return undefined;
  }
  const detectionText = (params.detectionText ?? params.result.text ?? "").toLowerCase();
  const relative = /\bthis month\b|\blast month\b/i.test(detectionText);
  const containsMonth = Object.keys(MONTH_INDEX_BY_ENGLISH).some((month) => detectionText.includes(month));
  if (!relative && !containsMonth) {
    return undefined;
  }

  let year = parsedDate.getUTCFullYear();
  const monthIndex = parsedDate.getUTCMonth();
  if (!params.explicitYear && containsMonth && monthIndex > params.now.getUTCMonth()) {
    year -= 1;
  }
  return {
    ...monthRange(year, monthIndex),
    matchedText: params.matchedText ?? params.result.text,
  };
}

export function parseTimeRangeFromQuery(
  query: string,
  now = new Date(),
): { range?: TimeRange; queryWithoutTime: string } {
  const normalized = normalizeTimeQuery(query);
  if (!normalized.normalizedMatchedText) {
    return { queryWithoutTime: "" };
  }

  const results = chrono.en.parse(normalized.normalizedMatchedText, now, { forwardDate: true });
  const best = results[0];
  const range =
    best && normalized.monthLevel
      ? inferMonthRangeFromChrono({
          result: best,
          matchedText: normalized.matchedOriginalText,
          detectionText: normalized.normalizedMatchedText,
          explicitYear: normalized.explicitYear,
          now,
        })
      : undefined;

  return {
    range,
    queryWithoutTime: normalized.matchedOriginalText
      ? cleanQueryAfterTimeRemoval(query.replace(normalized.matchedOriginalText, " "))
      : cleanQueryAfterTimeRemoval(query),
  };
}

export function buildTimeRange(params: {
  query: string;
  from?: string;
  to?: string;
  enabled?: boolean;
  now?: Date;
}): { range?: TimeRange; queryWithoutTime: string } {
  const parsed =
    params.enabled === false
      ? { queryWithoutTime: normalizeWhitespace(params.query) }
      : parseTimeRangeFromQuery(params.query, params.now);
  if (params.from || params.to) {
    const start = params.from ?? params.to ?? "";
    const end = params.to ?? params.from ?? "";
    const explicit = explicitRange(start, end);
    return {
      range: explicit,
      queryWithoutTime: parsed.queryWithoutTime,
    };
  }
  return parsed;
}

export function resolveResultTimeMs(result: MemoryBraidResult): number | undefined {
  const metadata = asRecord(result.metadata);
  const fields = [metadata.eventAt, metadata.firstSeenAt, metadata.indexedAt, metadata.createdAt];
  for (const value of fields) {
    const text = asString(value);
    if (!text) {
      continue;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function isResultInTimeRange(result: MemoryBraidResult, range?: TimeRange): boolean {
  if (!range) {
    return true;
  }
  const ts = resolveResultTimeMs(result);
  if (!ts) {
    return false;
  }
  return ts >= range.startMs && ts <= range.endMs;
}

export function formatTimeRange(range?: TimeRange): string {
  if (!range) {
    return "n/a";
  }
  return `${range.startDate}..${range.endDate}`;
}

export function inferQuerySpecificity(text: string): "broad" | "specific" {
  const normalized = normalizeWhitespace(text);
  const tokenCount = (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  if (tokenCount >= 8) {
    return "specific";
  }
  return "broad";
}

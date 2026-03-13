import { describe, expect, it } from "vitest";
import { buildTimeRange, parseTimeRangeFromQuery } from "../src/temporal.js";

const NOW = new Date("2026-03-13T00:00:00.000Z");

describe("temporal parsing", () => {
  it("parses english month-only phrases with most-recent-past semantics", () => {
    const parsed = parseTimeRangeFromQuery("What did we discuss in June?", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2025-06-01",
      endDate: "2025-06-30",
      matchedText: "in June",
    });
    expect(parsed.queryWithoutTime).toBe("What did we discuss?");
  });

  it("parses english month phrases with explicit year", () => {
    const parsed = parseTimeRangeFromQuery("What did we discuss in June 2026?", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      matchedText: "in June 2026",
    });
  });

  it("parses spanish month-only phrases", () => {
    const parsed = parseTimeRangeFromQuery("Que discutimos en junio?", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2025-06-01",
      endDate: "2025-06-30",
      matchedText: "en junio",
    });
    expect(parsed.queryWithoutTime).toBe("Que discutimos?");
  });

  it("parses spanish month-only phrases with punctuation and accents", () => {
    const parsed = parseTimeRangeFromQuery("¿Qué discutimos en junio?", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2025-06-01",
      endDate: "2025-06-30",
      matchedText: "en junio",
    });
    expect(parsed.queryWithoutTime).toBe("¿Qué discutimos?");
  });

  it("parses spanish month phrases with explicit year", () => {
    const parsed = parseTimeRangeFromQuery("Que discutimos en junio de 2026?", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      matchedText: "en junio de 2026",
    });
  });

  it("parses spanish month phrases with 'del' year variant", () => {
    const parsed = parseTimeRangeFromQuery("Que discutimos en junio del 2026?", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      matchedText: "en junio del 2026",
    });
  });

  it("parses spanish setiembre variant", () => {
    const parsed = parseTimeRangeFromQuery("¿Qué discutimos en setiembre de 2025?", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2025-09-01",
      endDate: "2025-09-30",
      matchedText: "en setiembre de 2025",
    });
  });

  it("parses relative month phrases in english and spanish", () => {
    const english = parseTimeRangeFromQuery("show me notes from last month", NOW);
    const spanish = parseTimeRangeFromQuery("muestrame notas de el mes pasado", NOW);
    expect(english.range).toMatchObject({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    expect(spanish.range).toMatchObject({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
  });

  it("parses spanish 'este mes' phrases", () => {
    const parsed = parseTimeRangeFromQuery("muestrame lo que hablamos este mes", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      matchedText: "este mes",
    });
    expect(parsed.queryWithoutTime).toBe("muestrame lo que hablamos");
  });

  it("parses spanish 'mes pasado' without article", () => {
    const parsed = parseTimeRangeFromQuery("muestrame notas mes pasado", NOW);
    expect(parsed.range).toMatchObject({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      matchedText: "mes pasado",
    });
    expect(parsed.queryWithoutTime).toBe("muestrame notas");
  });

  it("prefers explicit from/to flags over natural language", () => {
    const built = buildTimeRange({
      query: "What did we discuss in June?",
      from: "2024-01-01",
      to: "2024-01-31",
      now: NOW,
    });
    expect(built.range).toMatchObject({
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });
    expect(built.queryWithoutTime).toBe("What did we discuss?");
  });
});

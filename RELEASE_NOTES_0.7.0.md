# Memory Braid 0.7.0 Release Notes

## Summary

`0.7.0` shifts Memory Braid from direct durable capture to a layered memory model:

- `episodic` for observed cross-session evidence
- `semantic` for consolidated compendium memories
- `procedural` for agent behavior learnings

This release also adds deterministic memory routing, auditable Mem0 search, taxonomy metadata, bilingual month-style time parsing, and structured observability around selection and consolidation.

## Highlights

### Deterministic memory selection

ML can still propose candidates, but final persistence and promotion decisions are local and rule-based. Memory Braid now decides `ignore|episodic|procedural|semantic` using configurable thresholds and stable signals such as:

- memory kind
- first-person ownership
- taxonomy richness and anchors
- support count
- recall reinforcement
- cross-session survival
- volatility penalties

### Consolidation

Compendium synthesis now runs:

- on startup
- on an interval
- opportunistically after capture-heavy runs
- on demand with `/memorybraid consolidate`

Promotion remains evidence-based: source episodic memories are retained and annotated rather than deleted.

### Audit and tracing

Operators can now inspect memory behavior with:

- `/memorybraid search`
- `/memorybraid stats`
- `/memorybraid status`

New debug events:

- `memory_braid.capture.selection`
- `memory_braid.consolidation.plan`
- `memory_braid.consolidation.supersede`

These are intended to make it possible to trace why a memory was kept, ignored, promoted, or superseded.

### Time-aware retrieval

Time parsing now uses `chrono-node` plus a thin bilingual adapter for common English and Spanish month phrases, including:

- `in June`
- `in June 2026`
- `en junio`
- `en junio de 2026`
- `en junio del 2026`
- `este mes`
- `el mes pasado`
- `mes pasado`

## Operational notes

- Session continuity is still expected to come from OpenClaw prompt context and compaction, not from a separate plugin-managed short-term memory lane.
- Time decay remains active where previously configured.
- Older records remain usable even if they do not contain the new metadata fields.

## Validation

- Full test suite passes: `95/95`

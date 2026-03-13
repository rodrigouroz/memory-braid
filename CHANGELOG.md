# Changelog

## 0.7.0 - 2026-03-13

### Added

- Layered memory model with `episodic`, `semantic`, and `procedural` Mem0 records.
- Deterministic memory-selection policy for capture and promotion with configurable thresholds.
- Automatic and manual consolidation via `/memorybraid consolidate`.
- Mem0-only audit search via `/memorybraid search`.
- Taxonomy metadata for `people`, `places`, `organizations`, `projects`, `tools`, and `topics`.
- Time-aware query parsing backed by `chrono-node`, with English and Spanish month-style coverage.
- Consolidation state tracking and expanded capture/consolidation stats.
- Dedicated tests for temporal parsing and deterministic memory selection.

### Changed

- User captures now land as `episodic` memories first instead of being treated as immediately durable semantic memory.
- Agent learnings now route through deterministic procedural selection before persistence.
- Consolidation promotion now depends on support, recall reinforcement, time survival, taxonomy anchors, and volatility penalties.
- `/memorybraid status`, `/memorybraid stats`, and `/memorybraid search` expose selection and consolidation metadata for audit.
- Plugin config and schema now expose selection and consolidation thresholds.

### Observability

- Added `memory_braid.capture.selection` debug events for accepted and rejected episodic/procedural selection decisions.
- Added `memory_braid.consolidation.plan` debug events with per-draft promotion summaries.
- Added `memory_braid.consolidation.supersede` debug events when older semantic memories are marked superseded.

### Compatibility

- Existing memories remain readable; missing new metadata falls back to legacy heuristics.
- Time decay and existing lifecycle cleanup behavior remain intact.

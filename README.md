# Memory Braid

Memory Braid is an OpenClaw `kind: "memory"` plugin that augments local memory search (core/QMD) with Mem0.

## Ownership model

Memory Braid is intentionally hybrid, but not with shared ownership.

- OpenClaw prompt context + compaction are the source of truth for the live session.
- Core/QMD is the source of truth for written documents, notes, and canonical project knowledge.
- Mem0 is the source of truth for learned cross-session memory such as preferences, recurring decisions, and procedural learnings.

The goal is hybrid retrieval with single ownership per memory class. Memory Braid should not re-own markdown knowledge, and Mem0 should not be treated as the canonical store for documents.

## Features

- Hybrid recall with split ownership: local memory + Mem0, merged with weighted RRF.
- Layered Mem0 memory: episodic captures, semantic compendium memories, and procedural agent learnings.
- Capture-first Mem0 memory: plugin writes only captured memories to Mem0 (no markdown/session indexing).
- Capture pipeline modes: `local`, `hybrid`, `ml`.
- Deterministic memory selection policy: ML may suggest candidates, but plugin code decides `ignore|episodic|procedural|semantic` using local thresholds and heuristics.
- Optional entity extraction: local multilingual NER or OpenAI NER with canonical `entity://...` URIs in memory metadata.
- Lightweight taxonomy on captured and semantic memories: `people`, `places`, `organizations`, `projects`, `tools`, `topics`.
- Time-aware retrieval for month-style prompts such as `in June`, `this month`, and `last month`.
- Automatic consolidation loop that promotes repeated episodic memories into semantic compendium memories.
- Structured debug logs for troubleshooting and tuning.
- Debug-only LLM usage observability: per-turn cache usage, rolling windows, and rising/stable/improving trend logs.

## Hardening update

This release hardens capture and remediation for historical installs.

- Bug class: historical prompt or transcript content could be captured as Mem0 memories and later re-injected.
- Impact: inflated prompt size, noisier recall, and potentially higher Anthropic cache-write costs.
- Fix: new captures are assembled from the trusted current turn instead of mining the full `agent_end` transcript.
- Metadata: new captured memories now include additive provenance fields such as `captureOrigin`, `captureMessageHash`, `captureTurnHash`, `capturePath`, and `pluginCaptureVersion`.
- Historical installs: no startup mutation is performed automatically. Operators should audit first, then explicitly quarantine or delete suspicious captured memories.

## Command surface

Memory Braid exposes audit, search, consolidation, and remediation commands:

```bash
/memorybraid search standups --layer semantic --kind preference
/memorybraid search "What did we discuss in June?" --layer episodic
/memorybraid consolidate
/memorybraid audit
/memorybraid remediate audit
/memorybraid remediate quarantine
/memorybraid remediate quarantine --apply
/memorybraid remediate delete --apply
/memorybraid remediate purge-all-captured --apply
```

Notes:

- `search` is Mem0-only and intended for validating plugin-managed memory rather than local markdown memory.
- `search` supports `--limit`, `--layer`, `--kind`, `--from`, `--to`, and `--include-quarantined`.
- `consolidate` runs one compendium synthesis pass immediately and reports how many semantic memories were created or updated.
- New capture metadata includes deterministic selection fields such as `selectionDecision`, `rememberabilityScore`, and `rememberabilityReasons`.
- Dry-run is the default for remediation commands. Nothing mutates until you pass `--apply`.
- `audit` reports counts by `sourceType`, `captureOrigin`, and `pluginCaptureVersion`, plus suspicious legacy samples.
- `quarantine --apply` excludes suspicious captured memories from future Mem0 injection. It records quarantine state locally and also tags Mem0 metadata where supported.
- `delete --apply` deletes suspicious captured memories only.
- `purge-all-captured --apply` deletes all plugin-captured Mem0 records for the current workspace scope without touching local markdown memory.
- Optional flags:
  - `--limit N` controls how many Mem0 records are fetched during audit/remediation.
  - `--sample N` controls how many suspicious samples are shown in the audit report.

## Debug cost observability

When `debug.enabled` is `true`, Memory Braid also emits debug-only LLM usage observability logs from the `llm_output` hook:

- `memory_braid.cost.turn`: per-turn input/output/cache tokens, cache ratios, and a best-effort estimated USD cost when the provider/model has a known pricing profile.
- `memory_braid.cost.window`: rolling 5-turn and 20-turn averages plus `rising|stable|improving` trend labels for prompt size, cache-write rate, cache-hit rate, and estimated cost.
- `memory_braid.cost.alert`: emitted only when recent cache writes, prompt size, or estimated cost rise materially above the previous short window.

Important:

- `estimatedCostUsd` is intentionally labeled as an estimate.
- Unknown models still log token and cache trends, but the cost basis becomes `token_only`.

## Self-hosted reset option

If you are self-hosting and prefer a full reset instead of selective remediation, you can clear Memory Braid's OSS Mem0 state and restart OpenClaw:

```bash
rm -rf ~/.openclaw/memory-braid
openclaw gateway restart
```

This is intentionally not done by the plugin itself. It is an operator choice.

## Breaking changes in 0.4.0

Memory Braid `0.4.0` is intentionally simplified to capture/recall-only mode.

- Removed managed indexing features:
  - `bootstrap` config block removed.
  - `reconcile` config block removed.
  - startup bootstrap/reconcile flows removed.
- Mem0 is now used only for captured memories.
  - markdown and session indexing is no longer done by this plugin.
  - local markdown/session retrieval remains in core/QMD via `memory_search`.
- `/memorybraid stats` now reports capture + lifecycle only (no reconcile section).
- Legacy Mem0 records with `metadata.sourceType` of `markdown` or `session` are ignored during Mem0 recall merge.

Migration:

- If you relied on bootstrap/reconcile mirroring, pin to `<0.4.0`.
- For `0.4.0+`, remove `bootstrap` and `reconcile` from your plugin config.
- Keep OpenClaw prompt context as the source of truth for the live session.
- Keep core/QMD as the source of truth for markdown and canonical written knowledge.
- Use Memory Braid + Mem0 for learned cross-session memory, consolidation, and lifecycle management.

## Install

### Install from npm (recommended)

On the target machine:

1. Install from npm:

```bash
openclaw plugins install memory-braid@0.8.0
```

2. Rebuild native dependencies inside the installed extension:

```bash
cd ~/.openclaw/extensions/memory-braid
npm rebuild better-sqlite3 sharp
```

Why this step exists:
- OpenClaw plugin installs run `npm install --omit=dev --ignore-scripts` for safety.
- This behavior is currently not user-overridable from `openclaw plugins install`.
- `memory-braid` needs native artifacts for `better-sqlite3` (required by Mem0 OSS) and `sharp` (used by `@xenova/transformers`).

3. Enable and set as active memory slot:

```bash
openclaw plugins enable memory-braid
openclaw config set plugins.slots.memory memory-braid
```

4. Restart gateway:

```bash
openclaw gateway restart
```

5. Confirm plugin is loaded:

```bash
openclaw plugins info memory-braid
```

Expected:
- `Status: loaded`
- `Tools: memory_search, memory_get`
- `Services: memory-braid-service`

### Install from local path (development)

```bash
openclaw plugins install --link /absolute/path/to/memory-braid
openclaw plugins enable memory-braid
openclaw config set plugins.slots.memory memory-braid
openclaw gateway restart
```

If you install from npm and see native module errors like:

- `Could not locate the bindings file` (`better-sqlite3`)
- `.../node_modules/jiti/.../node_sqlite3.node` in the stack/error text
- `Cannot find module ... sharp-*.node`

run:

```bash
cd ~/.openclaw/extensions/memory-braid
npm rebuild better-sqlite3 sharp
openclaw gateway restart
```

Note:
- The `jiti/.../node_sqlite3.node` error is still a sqlite native artifact/runtime loading issue.
- `memory-braid` now preloads sqlite via native `require` to avoid that path, but you still need `npm rebuild better-sqlite3 sharp` after `--ignore-scripts` installs.
- When this happens, startup logs now include `memory_braid.mem0.error` with:
  - `sqliteBindingsError: true`
  - `fixCommand` (copy/paste command for that machine)
  - `pluginDir` (resolved extension directory when available)

## Quick start: hybrid capture + entity extraction

Add this under `plugins.entries["memory-braid"].config` in your OpenClaw config:

```json
{
  "mem0": {
    "mode": "oss",
    "ossConfig": {
      "version": "v1.1",
      "embedder": {
        "provider": "openai",
        "config": {
          "apiKey": "${OPENAI_API_KEY}",
          "model": "text-embedding-3-small"
        }
      },
      "vectorStore": {
        "provider": "memory",
        "config": {
          "collectionName": "memories",
          "dimension": 1536
        }
      },
      "llm": {
        "provider": "openai",
        "config": {
          "apiKey": "${OPENAI_API_KEY}",
          "model": "gpt-4o-mini"
        }
      },
      "enableGraph": false
    }
  },
  "capture": {
    "enabled": true,
    "mode": "hybrid",
    "includeAssistant": false,
    "maxItemsPerRun": 6,
    "ml": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "timeoutMs": 2500
    }
  },
  "entityExtraction": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-4o-mini",
    "timeoutMs": 2500,
    "minScore": 0.65,
    "maxEntitiesPerMemory": 8,
    "startup": {
      "downloadOnStartup": false,
      "warmupText": "John works at Acme in Berlin."
    }
  },
  "consolidation": {
    "enabled": true,
    "startupRun": false,
    "intervalMinutes": 360,
    "opportunisticNewMemoryThreshold": 5,
    "opportunisticMinMinutesSinceLastRun": 30,
    "minSupportCount": 2,
    "minRecallCount": 2,
    "semanticMaxSourceIds": 20,
    "timeQueryParsing": true
  },
  "debug": {
    "enabled": true
  }
}
```

Local-model alternative (fully backward compatible):

```json
{
  "entityExtraction": {
    "enabled": true,
    "provider": "multilingual_ner",
    "model": "Xenova/bert-base-multilingual-cased-ner-hrl"
  }
}
```

Then restart:

```bash
openclaw gateway restart
```

## Verification checklist

1. Check runtime status:

```bash
openclaw plugins info memory-braid
openclaw gateway status
```

2. Trigger/inspect entity warmup:

```bash
openclaw agent --agent main --message "/memorybraid warmup" --json
```

3. Send a message that should be captured:

```bash
openclaw agent --agent main --message "Remember that Ana works at OpenClaw and likes ramen." --json
```

4. Inspect logs for capture + NER:

```bash
rg -n "memory_braid\\.startup|memory_braid\\.capture|memory_braid\\.entity|memory_braid\\.mem0" ~/.openclaw/logs/gateway.log | tail -n 80
```

Expected events:
- `memory_braid.startup`
- `memory_braid.entity.model_load` (local `multilingual_ner` provider only)
- `memory_braid.entity.warmup`
- `memory_braid.capture.extract`
- `memory_braid.capture.ml` (for `capture.mode=hybrid|ml`)
- `memory_braid.entity.extract`
- `memory_braid.capture.selection`
- `memory_braid.capture.persist`

## Self-hosting quick guide

Memory Braid supports two self-hosted setups:

1. **API-compatible mode** (`mem0.mode: "cloud"` + `mem0.host`): run a Mem0-compatible API service and point the plugin to it.
2. **OSS in-process mode** (`mem0.mode: "oss"` + `mem0.ossConfig`): run Mem0 OSS directly in the OpenClaw process.

### Option A: self-hosted API-compatible mode

1. Deploy your Mem0 API-compatible stack in your infra (Docker/K8s/VM).
2. Make sure it is reachable from the OpenClaw host.
3. Configure Memory Braid with:
   - `mem0.mode: "cloud"`
   - `mem0.host: "http://<your-mem0-host>:<port>"`
   - `mem0.apiKey`
4. Restart OpenClaw.
5. Validate connectivity:
   - `curl -sS http://<your-mem0-host>:<port>/v1/ping/`
   - Then run one OpenClaw turn and confirm logs include `memory_braid.mem0.request` and `memory_braid.mem0.response`.

### Option B: OSS in-process mode (recommended for local/self-hosted tests)

1. Set `mem0.mode` to `oss`.
2. Provide `mem0.ossConfig` with:
   - `embedder` (provider + credentials/model)
   - `vectorStore` (provider + connection/config)
   - `llm` (provider + model; used by Mem0 OSS internals)
   - Partial `ossConfig` is safe: Memory Braid deep-merges your values over OSS defaults.
     - If a section provider changes (for example `embedder.provider: "ollama"`), that section is replaced instead of mixed.
3. Restart OpenClaw.
4. Send at least one message to trigger capture/recall.
5. Check logs for:
   - `memory_braid.startup`
   - `memory_braid.mem0.request|response`

### Smoke test checklist

1. Enable debug:
   - `plugins.memory-braid.debug.enabled: true`
2. Start OpenClaw.
3. Send a preference/decision statement.
4. Confirm later `memory_search` runs return merged local+Mem0 results.
5. Run `/memorybraid stats` to verify capture counters increase.

### Notes

- Memory Braid 0.4.0 is capture/recall-only by design: markdown and session indexing stay in core/QMD.
- If self-hosted infra is down, local memory tools continue working; Mem0 side degrades gracefully.
- For Mem0 platform/API specifics, see official docs: [Mem0 OSS quickstart](https://docs.mem0.ai/open-source/node-quickstart) and [Mem0 API reference](https://docs.mem0.ai/api-reference).

## Required config (Cloud API mode)

At minimum, provide Mem0 credentials:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-braid"
    },
    "memory-braid": {
      "mem0": {
        "apiKey": "${MEM0_API_KEY}"
      }
    }
  }
}
```

For self-hosted Mem0 API-compatible deployments, also set `mem0.host`:

```json
{
  "plugins": {
    "memory-braid": {
      "mem0": {
        "mode": "cloud",
        "host": "http://localhost:8000",
        "apiKey": "${MEM0_API_KEY}"
      }
    }
  }
}
```

## Required config (OSS self-hosted mode)

If you want `mem0ai/oss` directly, set `mem0.mode` to `oss` and pass an `ossConfig`.

By default, Memory Braid now auto-creates a state folder at
`<OPENCLAW_STATE_DIR>/memory-braid` (typically `~/.openclaw/memory-braid`) and uses:

- `mem0-history.db` for Mem0 history SQLite
- `mem0-vector-store.db` for Mem0 in-memory vector store SQLite backend (`vectorStore.provider: "memory"`)

You only need to set explicit DB paths if you want non-default locations.

```json
{
  "plugins": {
    "memory-braid": {
      "mem0": {
        "mode": "oss",
        "ossConfig": {
          "version": "v1.1",
          "embedder": {
            "provider": "openai",
            "config": {
              "apiKey": "${OPENAI_API_KEY}",
              "model": "text-embedding-3-small"
            }
          },
          "vectorStore": {
            "provider": "memory",
            "config": {
              "collectionName": "memories",
              "dimension": 1536
            }
          },
          "llm": {
            "provider": "openai",
            "config": {
              "apiKey": "${OPENAI_API_KEY}",
              "model": "gpt-4o-mini"
            }
          },
          "enableGraph": false
        }
      }
    }
  }
}
```

### Ready-made OSS preset: Qdrant + Ollama

Use this preset when:

- Your vector database is Qdrant.
- Your embedding and LLM provider is Ollama.
- OpenClaw can reach both services on your network.

```json
{
  "plugins": {
    "memory-braid": {
      "mem0": {
        "mode": "oss",
        "ossConfig": {
          "version": "v1.1",
          "embedder": {
            "provider": "ollama",
            "config": {
              "url": "http://127.0.0.1:11434",
              "model": "nomic-embed-text"
            }
          },
          "vectorStore": {
            "provider": "qdrant",
            "config": {
              "url": "http://127.0.0.1:6333",
              "collectionName": "openclaw_memory_braid",
              "dimension": 768
            }
          },
          "llm": {
            "provider": "ollama",
            "config": {
              "baseURL": "http://127.0.0.1:11434",
              "model": "llama3.1:8b"
            }
          },
          "enableGraph": false,
          "disableHistory": true
        }
      }
    }
  }
}
```

#### Quick validation for this preset

1. Ensure models are available in Ollama:
   - `ollama pull nomic-embed-text`
   - `ollama pull llama3.1:8b`
2. Ensure Qdrant is reachable:
   - `curl -sS http://127.0.0.1:6333/collections`
3. Start OpenClaw with `debug.enabled: true` and verify:
   - `memory_braid.startup`
   - `memory_braid.mem0.response` with `mode: "oss"`

## Recommended config

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-braid"
    },
    "memory-braid": {
      "recall": {
        "maxResults": 8,
        "injectTopK": 4,
        "user": {
          "enabled": true,
          "injectTopK": 4
        },
        "agent": {
          "enabled": true,
          "injectTopK": 2,
          "minScore": 0.78,
          "onlyPlanning": true
        },
        "merge": {
          "rrfK": 60,
          "localWeight": 1,
          "mem0Weight": 1
        }
      },
      "capture": {
        "enabled": true,
        "mode": "hybrid",
        "includeAssistant": false,
        "maxItemsPerRun": 6,
        "assistant": {
          "enabled": true,
          "autoCapture": false,
          "explicitTool": true,
          "maxItemsPerRun": 2,
          "minUtilityScore": 0.8,
          "minNoveltyScore": 0.85,
          "maxWritesPerSessionWindow": 3,
          "cooldownMinutes": 5
        },
        "ml": {
          "provider": "openai",
          "model": "gpt-4o-mini",
          "timeoutMs": 2500
        }
      },
      "entityExtraction": {
        "enabled": true,
        "provider": "openai",
        "model": "gpt-4o-mini",
        "timeoutMs": 2500,
        "minScore": 0.65,
        "maxEntitiesPerMemory": 8,
        "startup": {
          "downloadOnStartup": false,
          "warmupText": "John works at Acme in Berlin."
        }
      },
      "dedupe": {
        "lexical": { "minJaccard": 0.3 },
        "semantic": { "enabled": true, "minScore": 0.92 }
      },
      "timeDecay": {
        "enabled": false
      },
      "lifecycle": {
        "enabled": false,
        "captureTtlDays": 90,
        "cleanupIntervalMinutes": 360,
        "reinforceOnRecall": true
      },
      "debug": {
        "enabled": false,
        "includePayloads": false,
        "maxSnippetChars": 500,
        "logSamplingRate": 1
      }
    }
  }
}
```

## Capture defaults

Capture defaults are:

- `capture.enabled`: `true`
- `capture.mode`: `"local"`
- `capture.includeAssistant`: `false` (legacy alias for `capture.assistant.autoCapture`)
- `capture.selection.minPreferenceDecisionScore`: `0.45`
- `capture.selection.minFactScore`: `0.52`
- `capture.selection.minTaskScore`: `0.72`
- `capture.selection.minOtherScore`: `0.82`
- `capture.selection.minProceduralScore`: `0.58`
- `capture.maxItemsPerRun`: `6`
- `capture.assistant.enabled`: `true`
- `capture.assistant.autoCapture`: `false`
- `capture.assistant.explicitTool`: `true`
- `capture.assistant.maxItemsPerRun`: `2`
- `capture.assistant.minUtilityScore`: `0.8`
- `capture.assistant.minNoveltyScore`: `0.85`
- `capture.assistant.maxWritesPerSessionWindow`: `3`
- `capture.assistant.cooldownMinutes`: `5`
- `recall.user.injectTopK`: `5` (legacy `recall.injectTopK` still works)
- `recall.agent.injectTopK`: `2`
- `recall.agent.minScore`: `0.78`
- `recall.agent.onlyPlanning`: `true`
- `capture.ml.provider`: unset
- `capture.ml.model`: unset
- `capture.ml.timeoutMs`: `2500`
- `timeDecay.enabled`: `false`
- `lifecycle.enabled`: `false`
- `lifecycle.captureTtlDays`: `90`
- `consolidation.minSelectionScore`: `0.56`
- `lifecycle.cleanupIntervalMinutes`: `360`
- `lifecycle.reinforceOnRecall`: `true`

Important behavior:

- `capture.mode = "local"`: heuristic-only extraction.
- `capture.mode = "hybrid"`: heuristic extraction + ML enrichment when ML config is set.
- `capture.mode = "ml"`: ML-first extraction; falls back to heuristic if ML config/call is unavailable.
- New memories are persisted by `workspace + agent`, not by session. `sessionKey` is kept only as metadata and for assistant-learning cooldown/window logic.
- Recall still performs a legacy dual-read fallback for older session-scoped Mem0 records, without rewriting them.
- `capture.includeAssistant = false` (default): assistant auto-capture is off.
- `capture.includeAssistant = true` or `capture.assistant.autoCapture = true`: assistant messages are eligible for strict agent-learning auto-capture.
- `capture.assistant.explicitTool = true`: exposes the `remember_learning` tool.
- `recall.user.*` controls injected user memories.
- `recall.agent.*` controls injected agent learnings.
- ML calls run only when both `capture.ml.provider` and `capture.ml.model` are set.
- `timeDecay.enabled = true`: applies temporal decay to Mem0 results using Memory Core's `agents.*.memorySearch.query.hybrid.temporalDecay` settings.
- If Memory Core temporal decay is disabled, Mem0 decay is skipped even when `timeDecay.enabled = true`.
- `lifecycle.enabled = true`: tracks captured Mem0 IDs, applies TTL cleanup, and exposes `/memorybraid cleanup`.
- `lifecycle.reinforceOnRecall = true`: successful recalls refresh lifecycle timestamps, extending TTL survival for frequently used memories.

## Agent learnings

Memory Braid v2 adds explicit and implicit agent learnings.

- `remember_learning` stores compact reusable heuristics, lessons, and strategies for future runs.
- Use it for operational guidance that helps the agent avoid repeated mistakes or reduce tool cost/noise.
- Do not use it for long summaries, transient details, or raw reasoning.
- Assistant auto-capture is still available, but it is stricter than user-memory capture and only persists compact learnings that pass utility, novelty, and cooldown checks.

Recall is now split into two dynamic blocks:

- `<user-memories>`: user facts, preferences, decisions, and tasks.
- `<agent-learnings>`: reusable agent heuristics, lessons, and strategies.

Cache safety:

- Tool awareness for `remember_learning` is injected through a stable `systemPrompt`.
- Retrieved memories stay in dynamic `prependContext`, not in the stable prompt body.
- Agent learnings use low `top-k`, high relevance thresholds, and deterministic formatting to avoid unnecessary prompt churn.

## Entity extraction defaults

Entity extraction defaults are:

- `entityExtraction.enabled`: `false`
- `entityExtraction.provider`: `"multilingual_ner"`
- `entityExtraction.model`: `"Xenova/bert-base-multilingual-cased-ner-hrl"` (or `"gpt-4o-mini"` when `provider: "openai"` and model is unset)
- `entityExtraction.timeoutMs`: `2500`
- `entityExtraction.minScore`: `0.65`
- `entityExtraction.maxEntitiesPerMemory`: `8`
- `entityExtraction.startup.downloadOnStartup`: `false`
- `entityExtraction.startup.warmupText`: `"John works at Acme in Berlin."`

When enabled:

- Local NER model cache/download path is `<OPENCLAW_STATE_DIR>/memory-braid/models/entity-extraction` (typically `~/.openclaw/memory-braid/models/entity-extraction`).
- Captured memories get `metadata.entities` and `metadata.entityUris` (canonical IDs like `entity://person/john-doe`).
- Startup warmup is opt-in (`downloadOnStartup: false`) so model prewarm does not land on the critical gateway startup path.

Warmup command:

- `/memorybraid status`
- `/memorybraid stats`
- `/memorybraid cleanup`
- `/memorybraid warmup`
- `/memorybraid warmup --force`

## Debugging

Set:

```json
{
  "plugins": {
    "memory-braid": {
      "debug": {
        "enabled": true
      }
    }
  }
}
```

Key events:

- `memory_braid.startup`
- `memory_braid.config`
- `memory_braid.search.local|mem0|merge|inject|skip`
- `memory_braid.search.mem0_decay`
- `memory_braid.capture.extract|ml|persist|skip`
- `memory_braid.capture.selection`
- `memory_braid.consolidation.plan|run|supersede`
- `memory_braid.lifecycle.reinforce|cleanup`
- `memory_braid.entity.model_load|warmup|extract`
- `memory_braid.mem0.request|response|error`

`debug.includePayloads=true` includes payload fields; otherwise sensitive text fields are omitted.
`memory_braid.search.inject` now logs `injectedTextPreview` when payloads are enabled.

Traceability tips:

- Use `runId` to follow one execution end-to-end across capture/search/entity/mem0 events.
- `memory_braid.capture.persist` includes high-signal counters:
  - `dedupeSkipped`
  - `mem0AddAttempts`
  - `mem0AddWithId`
  - `mem0AddWithoutId`
  - `entityAnnotatedCandidates`
  - `totalEntitiesAttached`
- `memory_braid.capture.selection` includes the deterministic routing decision, numeric rememberability score, and reasons used for `ignore|episodic|procedural`.
- `memory_braid.consolidation.plan` includes the compendium drafts that passed deterministic promotion, including promotion score and reasons.
- `memory_braid.capture.ml` includes `fallbackUsed` and fallback reasons when ML is unavailable.
- `memory_braid.entity.extract` includes `entityTypes` and `sampleEntityUris`.

Example:

```bash
rg -n "memory_braid\\.|runId\":\"<RUN_ID>\"" ~/.openclaw/logs/gateway.log | tail -n 120
```

## Tests

```bash
npm test
```

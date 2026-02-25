# Memory Braid

Memory Braid is an OpenClaw `kind: "memory"` plugin that augments local memory search (core/QMD) with Mem0.

## Features

- Hybrid recall: local memory + Mem0, merged with weighted RRF.
- Install-time bootstrap import: indexes existing `MEMORY.md`, `memory.md`, `memory/**/*.md`, and recent sessions.
- Periodic reconcile: keeps remote Mem0 chunks updated and deletes stale remote chunks.
- Capture pipeline modes: `local`, `hybrid`, `ml`.
- Optional entity extraction: multilingual NER with canonical `entity://...` URIs in memory metadata.
- Structured debug logs for troubleshooting and tuning.

## Install

### Install from npm (recommended)

On the target machine:

1. Install from npm:

```bash
openclaw plugins install memory-braid@0.3.2
```

2. Rebuild native dependencies inside the installed extension:

```bash
cd ~/.openclaw/extensions/memory-braid
npm rebuild sqlite3 sharp
```

Why this step exists:
- OpenClaw plugin installs run `npm install --omit=dev --ignore-scripts` for safety.
- This behavior is currently not user-overridable from `openclaw plugins install`.
- `memory-braid` needs native artifacts for `sqlite3` (required by Mem0 OSS) and `sharp` (used by `@xenova/transformers`).

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

- `Could not locate the bindings file` (sqlite3)
- `Cannot find module ... sharp-*.node`

run:

```bash
cd ~/.openclaw/extensions/memory-braid
npm rebuild sqlite3 sharp
openclaw gateway restart
```

## Quick start: hybrid capture + multilingual NER

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
    "maxItemsPerRun": 6,
    "ml": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "timeoutMs": 2500
    }
  },
  "entityExtraction": {
    "enabled": true,
    "provider": "multilingual_ner",
    "model": "Xenova/bert-base-multilingual-cased-ner-hrl",
    "minScore": 0.65,
    "maxEntitiesPerMemory": 8,
    "startup": {
      "downloadOnStartup": true,
      "warmupText": "John works at Acme in Berlin."
    }
  },
  "debug": {
    "enabled": true
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

2. Trigger/inspect NER warmup:

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
- `memory_braid.entity.model_load`
- `memory_braid.entity.warmup`
- `memory_braid.capture.extract`
- `memory_braid.capture.ml` (for `capture.mode=hybrid|ml`)
- `memory_braid.entity.extract`
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
3. Restart OpenClaw.
4. Send at least one message to trigger capture/recall.
5. Check logs for:
   - `memory_braid.startup`
   - `memory_braid.bootstrap.begin|complete`
   - `memory_braid.reconcile.begin|complete`
   - `memory_braid.mem0.request|response`

### Smoke test checklist

1. Enable debug:
   - `plugins.memory-braid.debug.enabled: true`
2. Start OpenClaw and wait for bootstrap to finish.
3. Ask a query that should match existing memory (from `MEMORY.md` or recent sessions).
4. Confirm `memory_search` returns merged results.
5. Send a preference/decision statement and verify subsequent turns can recall it.

### Notes

- Bootstrap imports existing markdown memory + recent sessions once, then reconcile keeps remote state aligned.
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
   - `memory_braid.bootstrap.complete`

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
        "injectTopK": 5,
        "merge": {
          "rrfK": 60,
          "localWeight": 1,
          "mem0Weight": 1
        }
      },
      "bootstrap": {
        "enabled": true,
        "includeMarkdown": true,
        "includeSessions": true,
        "sessionLookbackDays": 90,
        "batchSize": 50,
        "concurrency": 3
      },
      "reconcile": {
        "enabled": true,
        "intervalMinutes": 30,
        "batchSize": 100,
        "deleteStale": true
      },
      "capture": {
        "enabled": true,
        "mode": "hybrid",
        "maxItemsPerRun": 6,
        "ml": {
          "provider": "openai",
          "model": "gpt-4o-mini",
          "timeoutMs": 2500
        }
      },
      "entityExtraction": {
        "enabled": true,
        "provider": "multilingual_ner",
        "model": "Xenova/bert-base-multilingual-cased-ner-hrl",
        "minScore": 0.65,
        "maxEntitiesPerMemory": 8,
        "startup": {
          "downloadOnStartup": true,
          "warmupText": "John works at Acme in Berlin."
        }
      },
      "dedupe": {
        "lexical": { "minJaccard": 0.3 },
        "semantic": { "enabled": true, "minScore": 0.92 }
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
- `capture.maxItemsPerRun`: `6`
- `capture.ml.provider`: unset
- `capture.ml.model`: unset
- `capture.ml.timeoutMs`: `2500`

Important behavior:

- `capture.mode = "local"`: heuristic-only extraction.
- `capture.mode = "hybrid"`: heuristic extraction + ML enrichment when ML config is set.
- `capture.mode = "ml"`: ML-first extraction; falls back to heuristic if ML config/call is unavailable.
- ML calls run only when both `capture.ml.provider` and `capture.ml.model` are set.

## Entity extraction defaults

Entity extraction defaults are:

- `entityExtraction.enabled`: `false`
- `entityExtraction.provider`: `"multilingual_ner"`
- `entityExtraction.model`: `"Xenova/bert-base-multilingual-cased-ner-hrl"`
- `entityExtraction.minScore`: `0.65`
- `entityExtraction.maxEntitiesPerMemory`: `8`
- `entityExtraction.startup.downloadOnStartup`: `true`
- `entityExtraction.startup.warmupText`: `"John works at Acme in Berlin."`

When enabled:

- Model cache/download path is `<OPENCLAW_STATE_DIR>/memory-braid/models/entity-extraction` (typically `~/.openclaw/memory-braid/models/entity-extraction`).
- Captured memories get `metadata.entities` and `metadata.entityUris` (canonical IDs like `entity://person/john-doe`).
- Startup can pre-download/warm the model (`downloadOnStartup: true`).

Warmup command:

- `/memorybraid status`
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
- `memory_braid.bootstrap.begin|complete|error`
- `memory_braid.reconcile.begin|progress|complete|error`
- `memory_braid.search.local|mem0|merge|inject|skip`
- `memory_braid.capture.extract|ml|persist|skip`
- `memory_braid.entity.model_load|warmup|extract`
- `memory_braid.mem0.request|response|error`

`debug.includePayloads=true` includes payload fields; otherwise sensitive text fields are omitted.

Traceability tips:

- Use `runId` to follow one execution end-to-end across capture/search/entity/mem0 events.
- `memory_braid.capture.persist` includes high-signal counters:
  - `dedupeSkipped`
  - `mem0AddAttempts`
  - `mem0AddWithId`
  - `mem0AddWithoutId`
  - `entityAnnotatedCandidates`
  - `totalEntitiesAttached`
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

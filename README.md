# Memory Braid

Memory Braid is an OpenClaw `kind: "memory"` plugin that augments local memory search (core/QMD) with Mem0.

## Features

- Hybrid recall: local memory + Mem0, merged with weighted RRF.
- Install-time bootstrap import: indexes existing `MEMORY.md`, `memory.md`, `memory/**/*.md`, and recent sessions.
- Periodic reconcile: keeps remote Mem0 chunks updated and deletes stale remote chunks.
- Capture pipeline: heuristic extraction with optional ML enrichment mode.
- Structured debug logs for troubleshooting and tuning.

## Install

Add this plugin to your OpenClaw plugin load path, then enable it as the active memory plugin.

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
        "extraction": {
          "mode": "heuristic"
        },
        "ml": {
          "provider": "openai",
          "model": "gpt-4o-mini",
          "timeoutMs": 2500,
          "maxItemsPerRun": 6
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
- `memory_braid.bootstrap.begin|complete|error`
- `memory_braid.reconcile.begin|progress|complete|error`
- `memory_braid.search.local|mem0|merge|inject`
- `memory_braid.capture.extract|ml|persist|skip`
- `memory_braid.mem0.request|response|error`

`debug.includePayloads=true` includes payload fields; otherwise sensitive text fields are omitted.

## Tests

```bash
npm test
```

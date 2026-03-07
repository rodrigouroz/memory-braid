import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryBraidResult } from "./types.js";

type ToolContext = {
  config?: unknown;
  sessionKey?: string;
};

type AnyTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (payload: unknown) => void,
  ) => Promise<unknown>;
};

function tryParseTextPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(first.text);
  } catch {
    return undefined;
  }
}

function extractDetailsPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const details = (value as { details?: unknown }).details;
  if (details && typeof details === "object") {
    return details;
  }
  return tryParseTextPayload(value);
}

export function resolveLocalTools(api: OpenClawPluginApi, ctx: ToolContext): {
  searchTool: AnyTool | null;
  getTool: AnyTool | null;
} {
  const searchTool = api.runtime.tools.createMemorySearchTool({
    config: ctx.config as never,
    agentSessionKey: ctx.sessionKey,
  }) as unknown as AnyTool | null;

  const getTool = api.runtime.tools.createMemoryGetTool({
    config: ctx.config as never,
    agentSessionKey: ctx.sessionKey,
  }) as unknown as AnyTool | null;

  return {
    searchTool: searchTool ?? null,
    getTool: getTool ?? null,
  };
}

export async function runLocalSearch(params: {
  searchTool: AnyTool;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate?: (payload: unknown) => void;
}): Promise<{ results: MemoryBraidResult[]; raw?: Record<string, unknown> }> {
  if (!params.searchTool.execute) {
    return { results: [] };
  }

  const value = await params.searchTool.execute(
    params.toolCallId,
    params.args,
    params.signal,
    params.onUpdate,
  );
  const details = extractDetailsPayload(value) as
    | {
        results?: Array<{
          path?: string;
          startLine?: number;
          endLine?: number;
          score?: number;
          snippet?: string;
          source?: string;
        }>;
      }
    | undefined;

  const results = (details?.results ?? [])
    .filter((item) => typeof item?.snippet === "string")
    .map((item) => ({
      source: "local" as const,
      path: item.path,
      startLine: typeof item.startLine === "number" ? item.startLine : undefined,
      endLine: typeof item.endLine === "number" ? item.endLine : undefined,
      snippet: item.snippet as string,
      score: typeof item.score === "number" ? item.score : 0,
    }));

  return {
    results,
    raw: details as Record<string, unknown> | undefined,
  };
}

export async function runLocalGet(params: {
  getTool: AnyTool;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate?: (payload: unknown) => void;
}): Promise<unknown> {
  if (!params.getTool.execute) {
    return {
      content: [{ type: "text", text: JSON.stringify({ path: "", text: "", disabled: true }) }],
      details: { path: "", text: "", disabled: true },
    };
  }
  return params.getTool.execute(params.toolCallId, params.args, params.signal, params.onUpdate);
}

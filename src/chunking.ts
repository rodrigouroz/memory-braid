import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedSourceType, ManifestChunk, TargetWorkspace } from "./types.js";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeForHash(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function buildChunkKey(params: {
  workspaceHash: string;
  agentId: string;
  sourceType: ManagedSourceType;
  path: string;
  index: number;
  text: string;
}): string {
  return sha256(
    [
      params.workspaceHash,
      params.agentId,
      params.sourceType,
      params.path,
      String(params.index),
      normalizeForHash(params.text),
    ].join("|"),
  );
}

export function chunkText(value: string, chunkSize = 1200, overlap = 180): string[] {
  const text = value.trim();
  if (!text) {
    return [];
  }
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + chunkSize);
    out.push(text.slice(cursor, end).trim());
    if (end >= text.length) {
      break;
    }
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return out.filter(Boolean);
}

async function walkMarkdownFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdownFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}

export async function listCanonicalMarkdownMemoryFiles(workspaceDir: string): Promise<string[]> {
  const result: string[] = [];
  const candidates = [path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "memory.md")];
  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        result.push(candidate);
      }
    } catch {
      // ignore
    }
  }

  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const stat = await fs.lstat(memoryDir);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await walkMarkdownFiles(memoryDir, result);
    }
  } catch {
    // ignore
  }

  return Array.from(new Set(result.map((filePath) => path.resolve(filePath))));
}

function normalizeSessionMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const item = block as { type?: unknown; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") {
      const normalized = normalizeWhitespace(item.text);
      if (normalized) {
        parts.push(normalized);
      }
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

export async function listRecentSessionFiles(
  stateDir: string,
  agentId: string,
  lookbackDays: number,
): Promise<string[]> {
  const dir = path.join(stateDir, "agents", agentId, "sessions");
  const threshold = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const abs = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(abs);
        if (stat.mtimeMs >= threshold) {
          files.push(abs);
        }
      } catch {
        // ignore single file failure
      }
    }
    return files;
  } catch {
    return [];
  }
}

export async function buildMarkdownChunks(target: TargetWorkspace): Promise<ManifestChunk[]> {
  const files = await listCanonicalMarkdownMemoryFiles(target.workspaceDir);
  const chunks: ManifestChunk[] = [];

  for (const filePath of files) {
    let raw = "";
    let statMtime = Date.now();
    try {
      raw = await fs.readFile(filePath, "utf8");
      const stat = await fs.stat(filePath);
      statMtime = stat.mtimeMs;
    } catch {
      continue;
    }

    const relPath = path.relative(target.workspaceDir, filePath).replace(/\\/g, "/");
    const pieces = chunkText(raw);
    pieces.forEach((piece, index) => {
      chunks.push({
        chunkKey: buildChunkKey({
          workspaceHash: target.workspaceHash,
          agentId: target.agentId,
          sourceType: "markdown",
          path: relPath,
          index,
          text: piece,
        }),
        contentHash: sha256(normalizeForHash(piece)),
        sourceType: "markdown",
        text: piece,
        path: relPath,
        workspaceHash: target.workspaceHash,
        agentId: target.agentId,
        updatedAt: statMtime,
      });
    });
  }

  return chunks;
}

export async function buildSessionChunks(
  target: TargetWorkspace,
  lookbackDays: number,
): Promise<ManifestChunk[]> {
  const files = await listRecentSessionFiles(target.stateDir, target.agentId, lookbackDays);
  const chunks: ManifestChunk[] = [];

  for (const filePath of files) {
    let raw = "";
    let statMtime = Date.now();
    try {
      raw = await fs.readFile(filePath, "utf8");
      const stat = await fs.stat(filePath);
      statMtime = stat.mtimeMs;
    } catch {
      continue;
    }

    const lines = raw.split("\n");
    const conversationParts: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const record = parsed as { type?: unknown; message?: unknown };
      if (record.type !== "message") {
        continue;
      }
      const message = record.message as { role?: unknown; content?: unknown } | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = normalizeSessionMessageText(message.content);
      if (!text) {
        continue;
      }
      const roleLabel = message.role === "user" ? "User" : "Assistant";
      conversationParts.push(`${roleLabel}: ${text}`);
    }

    if (conversationParts.length === 0) {
      continue;
    }

    const sessionText = conversationParts.join("\n");
    const sessionRelPath = path.join("sessions", target.agentId, path.basename(filePath)).replace(/\\/g, "/");
    const pieces = chunkText(sessionText);
    pieces.forEach((piece, index) => {
      chunks.push({
        chunkKey: buildChunkKey({
          workspaceHash: target.workspaceHash,
          agentId: target.agentId,
          sourceType: "session",
          path: sessionRelPath,
          index,
          text: piece,
        }),
        contentHash: sha256(normalizeForHash(piece)),
        sourceType: "session",
        text: piece,
        path: sessionRelPath,
        workspaceHash: target.workspaceHash,
        agentId: target.agentId,
        updatedAt: statMtime,
      });
    });
  }

  return chunks;
}

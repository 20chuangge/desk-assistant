/**
 * memory.mjs - human-readable, per-bot memory plus one small shared facts file.
 *
 * Layout:
 *   data/memory/<botId>/MEMORY.md   that bot's own notes
 *   data/memory/shared.md           facts every bot may use (user name, tz, prefs)
 *
 * Retrieval is intentionally dumb: keyword overlap plus a recency decay. No
 * embeddings, no vector store, no API call. For a single-user assistant with a
 * few hundred lines of memory this beats a vector DB on every axis that
 * matters here: it is inspectable, editable by hand, and impossible to get
 * "silently wrong".
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { P, readText, writeTextAtomic, appendText, nowIso } from './store.mjs';

const SHARED_ID = 'shared';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'will', 'have', 'from',
  'was', 'were', 'are', 'but', 'not', 'can', 'get', 'got', 'into', 'out', 'about',
  'what', 'when', 'where', 'who', 'how', 'why', 'all', 'any', 'some', 'then', 'than',
  'them', 'they', 'there', 'here', 'its', 'it', 'is', 'be', 'to', 'of', 'in', 'on',
  'at', 'as', 'or', 'if', 'we', 'us', 'me', 'my', 'i', 'a', 'an', 'do', 'did', 'does',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function headerFor(title) {
  return [
    `# ${title}`,
    '',
    '<!-- Append-only. One line per entry: "- <iso timestamp> | <fact>". -->',
    '<!-- A human should be able to read this file top to bottom and know what the bot knows. -->',
    '',
  ].join('\n');
}

export function memoryFileFor(botId) {
  if (botId === SHARED_ID) return path.join(P.memoryDir, 'shared.md');
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(P.memoryDir, safe, 'MEMORY.md');
}

/**
 * Entries are the markdown bullet lines. We tolerate hand-written bullets with
 * no timestamp (age unknown -> treated as "old" for scoring, still readable).
 */
export function parseEntries(raw, { fallbackTs = 0 } = {}) {
  const entries = [];
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\s*-\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*\|\s*(.+)$/);
    if (m) {
      const ts = Date.parse(m[1]);
      entries.push({ ts: Number.isNaN(ts) ? fallbackTs : ts, text: m[2].trim(), raw: line.trim() });
      continue;
    }
    const plain = line.match(/^\s*-\s+(.+)$/);
    if (plain && !plain[1].startsWith('<!--')) {
      entries.push({ ts: fallbackTs, text: plain[1].trim(), raw: line.trim() });
    }
  }
  return entries;
}

export async function readMemoryRaw(botId) {
  return readText(memoryFileFor(botId), '');
}

export async function readEntries(botId) {
  const raw = await readMemoryRaw(botId);
  const fileTs = await lastModified(memoryFileFor(botId));
  return parseEntries(raw, { fallbackTs: fileTs });
}

async function lastModified(file) {
  try {
    const st = await fsp.stat(file);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Append one fact. Newlines are flattened: memory is a list of one-liners, which
 * keeps retrieval scoring honest and the file diff-friendly.
 */
export async function appendMemory(botId, text, { title } = {}) {
  const clean = String(text || '').replace(/\s*\n+\s*/g, ' / ').trim();
  if (!clean) throw new Error('memory_write needs a non-empty text');
  if (clean.length > 4000) throw new Error('memory entry too long (max 4000 chars)');

  const file = memoryFileFor(botId);
  const existing = await readText(file, '');
  if (!existing.trim()) {
    await writeTextAtomic(file, headerFor(title || (botId === SHARED_ID ? 'Shared facts' : `${botId} - memory`)));
  }
  const line = `- ${nowIso()} | ${clean}\n`;
  await appendText(file, line);
  return { botId, text: clean, ts: nowIso() };
}

/** Replace the whole file. Used by the "edit memory" path in the UI/API. */
export async function writeMemory(botId, text) {
  const file = memoryFileFor(botId);
  const body = String(text ?? '');
  await writeTextAtomic(file, body.trim() ? body : `${headerFor(botId === SHARED_ID ? 'Shared facts' : `${botId} - memory`)}`);
  return { botId, bytes: body.length };
}

/**
 * Scoped retrieval.
 *
 * score = 2.0 * (query keywords present) + recency bonus
 * recency = 1.5 * exp(-ageDays / 30)   -> today = 1.5, a month ago = 0.55
 *
 * With no query we just return the most recent entries, which is what
 * "what do you remember?" should mean.
 */
export async function retrieve({ botId, query = '', limit = 8, includeShared = true } = {}) {
  const sources = [];
  if (botId && botId !== SHARED_ID) {
    sources.push({ source: botId, entries: await readEntries(botId) });
  }
  if (includeShared) {
    sources.push({ source: SHARED_ID, entries: await readEntries(SHARED_ID) });
  }

  const qTokens = tokenize(query);
  const now = Date.now();
  const scored = [];

  for (const { source, entries } of sources) {
    for (const entry of entries) {
      const entryTokens = new Set(tokenize(entry.text));
      let hits = 0;
      for (const token of qTokens) {
        if (entryTokens.has(token)) hits += 1;
        else {
          // Cheap prefix match so "deploy" also catches "deployment".
          for (const et of entryTokens) {
            if (et.startsWith(token) || token.startsWith(et)) {
              hits += 0.5;
              break;
            }
          }
        }
      }
      const ageDays = entry.ts ? Math.max(0, (now - entry.ts) / 86400000) : 365;
      const recency = 1.5 * Math.exp(-ageDays / 30);
      const score = hits * 2 + recency;
      if (qTokens.length === 0 || hits > 0) {
        scored.push({ ...entry, source, score: Number(score.toFixed(3)), hits });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const top = scored.slice(0, limit);
  // Nothing matched: fall back to recency so the bot still has some context.
  if (!top.length) {
    const recent = sources
      .flatMap(({ source, entries }) => entries.map((e) => ({ ...e, source, score: 0, hits: 0 })))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, Math.min(limit, 4));
    return recent;
  }
  return top;
}

/** Compact digest for the system prompt. */
export async function renderMemoryDigest({ botId, query = '', limit = 6 } = {}) {
  const entries = await retrieve({ botId, query, limit });
  if (!entries.length) return '(empty - nothing saved yet)';
  return entries
    .map((e) => {
      const when = e.ts ? new Date(e.ts).toISOString().slice(0, 10) : 'undated';
      const tag = e.source === SHARED_ID ? 'shared' : 'mine';
      return `- [${when}] [${tag}] ${e.text}`;
    })
    .join('\n');
}

export async function memorySnapshot(botId) {
  const own = await readMemoryRaw(botId);
  const shared = await readMemoryRaw(SHARED_ID);
  const entries = await readEntries(botId);
  return { botId, memory: own, shared, entries };
}

export { SHARED_ID };

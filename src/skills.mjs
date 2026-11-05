/**
 * skills.mjs - a shared library of markdown procedures with YAML-ish frontmatter.
 *
 * A skill is a file, and that is the whole point: "save what worked" turns into
 * writing a file into skills/, which any bot can then be granted. No database,
 * no migration, and a human can diff it.
 *
 * Format:
 *   ---
 *   name: workspace-sweep
 *   description: one line, what it does
 *   when_to_use: when to reach for it
 *   inputs:
 *     - workspace path
 *   steps:
 *     - first thing
 *     - second thing
 *   validation: how you know it worked
 *   output: what it produces
 *   approval_notes: what needs a human
 *   ---
 *
 *   free-form markdown body
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { P, readText, writeTextAtomic, listFiles, uid } from './store.mjs';

export const REQUIRED_FIELDS = [
  'name',
  'description',
  'when_to_use',
  'steps',
  'validation',
  'output',
  'approval_notes',
];

/** Stable, filesystem-safe name. "Daily Brief!" -> "daily-brief". */
export function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * A deliberately small frontmatter parser: scalars, and indented "- item" lists.
 * That covers every skill file we ship and every file the model is likely to
 * write. Anything richer would need a YAML dependency, which the brief forbids.
 */
export function parseFrontmatter(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---')) return { meta: {}, body: src };

  const end = src.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: src };

  const header = src.slice(3, end).replace(/^\n/, '');
  const body = src.slice(src.indexOf('\n', end + 1) + 1);

  const meta = {};
  let currentList = null;

  for (const rawLine of header.split('\n')) {
    if (!rawLine.trim()) continue;
    const listItem = rawLine.match(/^\s+-\s*(.+)$/);
    if (listItem && currentList) {
      currentList.push(unquote(listItem[1].trim()));
      continue;
    }
    const kv = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (!value) {
      currentList = [];
      meta[key] = currentList;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Inline list: steps: [a, b, c]
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
      currentList = null;
    } else {
      meta[key] = unquote(value);
      currentList = null;
    }
  }
  return { meta, body };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function renderFrontmatter(meta) {
  const lines = ['---'];
  for (const key of [...REQUIRED_FIELDS.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !REQUIRED_FIELDS.includes(k))]) {
    const value = meta[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${String(item).replace(/\n/g, ' ')}`);
    } else {
      lines.push(`${key}: ${String(value ?? '').replace(/\n/g, ' ')}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function skillPath(name) {
  return path.join(P.skillsDir, `${slugify(name)}.md`);
}

/** All skills in the library, with parsed metadata. Sorted by name. */
export async function listSkills() {
  const names = await listFiles(P.skillsDir, (n) => n.endsWith('.md'));
  const out = [];
  for (const file of names) {
    const filePath = path.join(P.skillsDir, file);
    let raw;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const fallbackName = file.replace(/\.md$/, '');
    out.push({
      name: meta.name || fallbackName,
      slug: fallbackName,
      description: meta.description || '',
      when_to_use: meta.when_to_use || '',
      steps: Array.isArray(meta.steps) ? meta.steps : meta.steps ? [String(meta.steps)] : [],
      validation: meta.validation || '',
      output: meta.output || '',
      approval_notes: meta.approval_notes || '',
      inputs: Array.isArray(meta.inputs) ? meta.inputs : [],
      file: path.relative(P.root, filePath).split(path.sep).join('/'),
      bytes: raw.length,
      bodyLength: body.trim().length,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readSkill(nameOrSlug) {
  const slug = slugify(nameOrSlug);
  const filePath = skillPath(slug);
  const raw = await readText(filePath, null);
  if (raw === null) {
    // Fall back to matching on the frontmatter name, in case the file was
    // renamed by hand.
    const all = await listSkills();
    const match = all.find((s) => s.name.toLowerCase() === String(nameOrSlug).toLowerCase());
    if (!match) return null;
    const fallbackRaw = await readText(path.join(P.root, match.file), '');
    const parsed = parseFrontmatter(fallbackRaw);
    return { ...match, raw: fallbackRaw, body: parsed.body.trim(), meta: parsed.meta };
  }
  const { meta, body } = parseFrontmatter(raw);
  return {
    name: meta.name || slug,
    slug,
    description: meta.description || '',
    when_to_use: meta.when_to_use || '',
    steps: Array.isArray(meta.steps) ? meta.steps : [],
    validation: meta.validation || '',
    output: meta.output || '',
    approval_notes: meta.approval_notes || '',
    inputs: Array.isArray(meta.inputs) ? meta.inputs : [],
    file: path.relative(P.root, filePath).split(path.sep).join('/'),
    meta,
    body: body.trim(),
    raw,
  };
}

/**
 * Write a new skill into the library. Returns the stored record.
 * Validation is strict on purpose: a skill missing "validation" or
 * "approval_notes" is a skill that will quietly do the wrong thing later.
 */
export async function saveSkill(input = {}) {
  const meta = {
    name: String(input.name || '').trim(),
    description: String(input.description || '').trim(),
    when_to_use: String(input.when_to_use || '').trim(),
    steps: normalizeList(input.steps),
    validation: String(input.validation || '').trim(),
    output: String(input.output || '').trim(),
    approval_notes: String(input.approval_notes || '').trim(),
  };
  if (Array.isArray(input.inputs) && input.inputs.length) meta.inputs = normalizeList(input.inputs);

  const missing = REQUIRED_FIELDS.filter((field) => {
    const v = meta[field];
    return Array.isArray(v) ? v.length === 0 : !v;
  });
  if (missing.length) {
    const err = new Error(`skill_save is missing required fields: ${missing.join(', ')}`);
    err.code = 'SKILL_INVALID';
    err.details = { missing };
    throw err;
  }

  const slug = slugify(meta.name);
  if (!slug) {
    const err = new Error('skill_save could not derive a filename from the name');
    err.code = 'SKILL_INVALID';
    throw err;
  }

  const body =
    String(input.body || '').trim() ||
    [`# ${meta.name}`, '', meta.description, '', ...meta.steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');

  const filePath = path.join(P.skillsDir, `${slug}.md`);
  const existed = await readText(filePath, null) !== null;
  const content = `${renderFrontmatter(meta)}\n${body}\n`;
  await writeTextAtomic(filePath, content);

  return {
    id: uid('skill'),
    slug,
    name: meta.name,
    file: path.relative(P.root, filePath).split(path.sep).join('/'),
    replaced: existed,
    meta,
    body,
  };
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Compact digest for the system prompt: name, when to use it, and nothing else.
 * The full body is loaded with skill_read when the bot actually decides to use it
 * (progressive disclosure - keeps the prompt small as the library grows).
 */
export async function renderSkillsDigest(grantedNames) {
  const all = await listSkills();
  const granted = new Set((grantedNames || []).map((n) => slugify(n)));
  const usable = all.filter((s) => granted.size === 0 || granted.has(s.slug) || granted.has(slugify(s.name)));
  if (!usable.length) {
    return granted.size === 0 ? '(no skills in the library yet)' : '(no skills granted to this bot)';
  }
  return usable
    .map((s) => `- ${s.slug}: ${s.description || '(no description)'} | use when: ${s.when_to_use || 'unspecified'}`)
    .join('\n');
}

/** Everything a bot may use, for the API/UI. */
export async function listSkillsForBot(grantedNames) {
  const all = await listSkills();
  const granted = new Set((grantedNames || []).map((n) => slugify(n)));
  return all.map((s) => ({ ...s, granted: granted.size === 0 || granted.has(s.slug) }));
}

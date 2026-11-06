/**
 * settings.mjs - product settings, and the one place a secret lives.
 *
 * Two files, deliberately separate:
 *
 *   config/settings.json   { provider, baseUrl, model }        - safe to read,
 *                                                                safe to commit
 *   data/secrets.json      { apiKey }                          - never logged,
 *                                                                never returned
 *
 * The split is the whole point: GET /api/settings can be as chatty as it likes
 * because it only ever projects { provider, baseUrl, model, hasKey }. The key is
 * only read here, handed to model.mjs in memory, and written on PUT.
 *
 * Defaults come from the environment so an existing deployment keeps working:
 *   ASSIST_MODEL_PROVIDER, ASSIST_BASE_URL, ASSIST_MODEL, ASSIST_API_KEY
 * A settings file, once written through the UI, wins over those defaults (the
 * file *is* the stored configuration; env vars are how a bare install starts).
 *
 * Mock stays the default. If someone selects a real provider but has no key,
 * the effective provider falls back to mock instead of every turn failing with
 * "API key required" - the UI already knows because hasKey is false.
 */

import fsp from 'node:fs/promises';
import { P, readJson, writeJsonAtomic } from './store.mjs';
import { createModel } from './model.mjs';
import { PROVIDER_NAMES, isKnownProvider, providerNeedsKey, providerPreset } from './providers.mjs';

/** Every provider the catalogue knows, in the order the UI lists them. */
export const PROVIDERS = PROVIDER_NAMES;
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function settingsError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** Settings used when nothing has been stored yet (env vars, then built-ins). */
export function defaultSettings() {
  const provider = String(env('ASSIST_MODEL_PROVIDER', 'mock')).trim().toLowerCase();
  return {
    provider: PROVIDERS.includes(provider) ? provider : 'mock',
    baseUrl: normalizeBaseUrl(env('ASSIST_BASE_URL', DEFAULT_BASE_URL)) || DEFAULT_BASE_URL,
    model: String(env('ASSIST_MODEL', DEFAULT_MODEL)).trim() || DEFAULT_MODEL,
    // Empty means "the human has not chosen": the UI falls back to the device
    // zone. Stored here so routines and the About panel agree with the UI.
    timezone: String(env('ASSIST_TIMEZONE', '')).trim(),
  };
}

function mergeSettings(base, patch = {}) {
  const next = { ...base };
  if (patch.provider !== undefined && patch.provider !== null) next.provider = String(patch.provider);
  if (patch.baseUrl !== undefined && patch.baseUrl !== null) next.baseUrl = String(patch.baseUrl);
  if (patch.model !== undefined && patch.model !== null) next.model = String(patch.model);
  if (patch.timezone !== undefined) next.timezone = String(patch.timezone ?? '');
  return next;
}

/** Validate and normalize. Throws a 400-shaped error the HTTP layer understands. */
export function validateSettings(input) {
  const provider = String(input?.provider ?? '').trim().toLowerCase();
  if (!isKnownProvider(provider)) {
    throw settingsError(400, 'INVALID_PROVIDER', `provider must be one of ${PROVIDER_NAMES.join(', ')}`);
  }

  // A provider with no preset URL (mock / custom) still needs something usable.
  const preset = providerPreset(provider);
  const baseUrl = normalizeBaseUrl(input?.baseUrl) || preset.baseUrl || DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw settingsError(400, 'INVALID_BASE_URL', 'baseUrl must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw settingsError(400, 'INVALID_BASE_URL', 'baseUrl must be an absolute http(s) URL');
  }

  const model = String(input?.model ?? '').trim();
  if (!model && provider !== 'mock') throw settingsError(400, 'INVALID_MODEL', 'model is required');
  if (model.length > 160) throw settingsError(400, 'INVALID_MODEL', 'model is limited to 160 characters');

  // Optional IANA zone. "" is valid ("not set yet"), but a typo must not be
  // silently swallowed: a wrong zone makes routines fire at the wrong hour.
  let timezone = String(input?.timezone ?? '').trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw settingsError(400, 'INVALID_TIMEZONE', `unknown timezone "${timezone}"`);
    }
    if (timezone.length > 64) throw settingsError(400, 'INVALID_TIMEZONE', 'timezone is limited to 64 characters');
  } else {
    timezone = '';
  }

  return { provider, baseUrl, model, timezone };
}

/** Stored settings merged over env/built-in defaults. A broken file never bricks boot. */
export async function loadSettings() {
  const defaults = defaultSettings();
  const raw = await readJson(P.settingsFile, null);
  if (!raw || typeof raw !== 'object') return defaults;

  const safePatch = {};
  if (typeof raw.provider === 'string') safePatch.provider = raw.provider;
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) safePatch.baseUrl = raw.baseUrl;
  if (typeof raw.model === 'string' && raw.model.trim()) safePatch.model = raw.model;
  if (typeof raw.timezone === 'string') safePatch.timezone = raw.timezone;

  try {
    return validateSettings(mergeSettings(defaults, safePatch));
  } catch (err) {
    console.error(`[settings] ${P.settingsFile} is invalid (${err.message}); using defaults`);
    return defaults;
  }
}

/** Merge a partial patch into the stored settings, validate, persist. */
export async function saveSettings(patch = {}) {
  const current = await loadSettings();
  const next = validateSettings(mergeSettings(current, patch || {}));
  await writeJsonAtomic(P.settingsFile, next);
  return next;
}

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

/**
 * Read the API key. A stored file wins even when it holds an empty string:
 * "clear the key" must not be undone by a leftover ASSIST_API_KEY in the
 * environment.
 */
export async function loadSecret() {
  const raw = await readJson(P.secretsFile, null);
  if (raw && typeof raw === 'object' && typeof raw.apiKey === 'string') return raw.apiKey;
  return env('ASSIST_API_KEY', '');
}

/** Write (or clear, with "") the API key. Returns the stored value. */
export async function saveSecret(apiKey) {
  const value = typeof apiKey === 'string' ? apiKey.trim() : '';
  await writeJsonAtomic(P.secretsFile, { apiKey: value, updatedAt: new Date().toISOString() });
  // Best effort on POSIX; Windows ignores the mode (the profile directory is the
  // protection there). Never throw because a chmod failed.
  try {
    await fsp.chmod(P.secretsFile, 0o600);
  } catch {
    /* ignore */
  }
  return value;
}

export function hasKey(apiKey) {
  return Boolean(apiKey && String(apiKey).trim());
}

/** The provider that will actually be used for the next request. */
export function effectiveProvider(settings, apiKey) {
  const provider = isKnownProvider(settings?.provider)
    ? String(settings.provider).toLowerCase()
    : 'mock';
  if (provider === 'mock') return 'mock';
  // Local runtimes (Ollama, LM Studio) need no key; everything else does.
  if (!providerNeedsKey(provider)) return provider;
  return hasKey(apiKey) ? provider : 'mock';
}

/** The only shape the API is allowed to expose. Note: no key, ever. */
export function publicModel(settings, apiKey) {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    timezone: settings.timezone || '',
    hasKey: hasKey(apiKey),
  };
}

/** Build the model client the agent loop uses. */
export function createModelFromSettings(settings, apiKey) {
  const provider = effectiveProvider(settings, apiKey);
  const model = createModel({
    provider,
    baseUrl: settings.baseUrl,
    apiKey: hasKey(apiKey) ? apiKey : '',
    model: settings.model,
  });
  // What the runtime *actually* is, so /api/health does not lie.
  model.requestedProvider = settings.provider;
  return model;
}

/**
 * POST /api/settings/test - one tiny completion, timed.
 * In mock mode this deliberately touches no network at all.
 */
export async function testConnection({ settings, apiKey, timeoutMs = 20000 } = {}) {
  const provider = effectiveProvider(settings, apiKey);
  const started = Date.now();
  // Mock mode answers from the local planner: report the mode and touch no network.
  if (provider === 'mock') return { ok: true, latencyMs: Date.now() - started, mode: 'mock' };

  try {
    const model = createModelFromSettings(settings, apiKey);
    const result = await model.complete([{ role: 'user', content: 'Reply with the single word: ok' }], {
      maxTokens: 8,
      temperature: 0,
      timeoutMs,
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      mode: 'live',
      provider,
      reply: String(result?.content || '').slice(0, 80),
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, mode: 'live', provider, error: { message: err.message } };
  }
}

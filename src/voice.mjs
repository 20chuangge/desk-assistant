/**
 * voice.mjs - speech to text for the composer's microphone.
 *
 * The browser records (MediaRecorder, webm/opus or mp4), the hub forwards the
 * bytes to an OpenAI-compatible POST {baseUrl}/audio/transcriptions, and the
 * text goes back into the composer for the human to read and send.
 *
 * Where the transcription service comes from, in order:
 *   1. its own settings  data/voice.json {baseUrl, model, apiKey}
 *   2. the chat model's provider, when that provider also transcribes
 *      (SiliconFlow / OpenAI / Groq): same URL and key, a known STT model
 * So a SiliconFlow user gets voice with no extra setup; a DeepSeek user adds
 * one key (SiliconFlow's SenseVoice is free).
 *
 * The key is write-only like the chat key: publicVoice() reports hasKey only.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, readJson, writeJsonAtomic } from './store.mjs';

const VOICE_FILE = path.join(P.dataDir, 'voice.json');

/** Providers whose chat endpoint also serves /audio/transcriptions. */
export const STT_FROM_PROVIDER = {
  siliconflow: 'FunAudioLLM/SenseVoiceSmall',
  openai: 'whisper-1',
  groq: 'whisper-large-v3-turbo',
};

/** Services with an OpenAI-compatible /audio/transcriptions. Any other one works through "custom". */
export const VOICE_PROVIDERS = [
  { id: 'siliconflow', label: '硅基流动 SenseVoice（免费，中文好）', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'openai', label: 'OpenAI Whisper', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'groq', label: 'Groq Whisper（快，有免费额度）', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyUrl: 'https://console.groq.com/keys' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', keyUrl: '' },
];

export const VOICE_PRESET = VOICE_PROVIDERS[0];

export const VOICE_MAX_BYTES = 10 * 1024 * 1024;

function voiceError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const trimUrl = (v) => String(v || '').trim().replace(/\/+$/, '');

export async function loadVoice() {
  const raw = await readJson(VOICE_FILE, null);
  if (!raw || typeof raw !== 'object') return { baseUrl: '', model: '', apiKey: '' };
  return { baseUrl: trimUrl(raw.baseUrl), model: String(raw.model || '').trim(), apiKey: String(raw.apiKey || '').trim() };
}

/** Patch {baseUrl?, model?, apiKey?}; apiKey "" clears it. Returns the stored config. */
export async function saveVoice(current, patch = {}) {
  const next = { ...current };
  if (patch.baseUrl !== undefined) {
    const url = trimUrl(patch.baseUrl);
    if (url && !/^https?:\/\//i.test(url)) throw voiceError(400, 'INVALID_BASE_URL', 'baseUrl must start with http:// or https://');
    next.baseUrl = url;
  }
  if (patch.model !== undefined) next.model = String(patch.model || '').trim().slice(0, 200);
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== 'string') throw voiceError(400, 'INVALID_API_KEY', 'apiKey must be a string');
    next.apiKey = patch.apiKey.trim();
  }
  await writeJsonAtomic(VOICE_FILE, { ...next, updatedAt: new Date().toISOString() });
  try { await fsp.chmod(VOICE_FILE, 0o600); } catch { /* Windows */ }
  return next;
}

/** The service a transcription will actually use, or null. */
export function resolveVoice(voice, settings, chatKey) {
  if (voice.apiKey) {
    return { source: 'own', baseUrl: voice.baseUrl || VOICE_PRESET.baseUrl, model: voice.model || VOICE_PRESET.model, apiKey: voice.apiKey };
  }
  const sttModel = STT_FROM_PROVIDER[settings?.provider];
  if (sttModel && chatKey) {
    return { source: 'model', baseUrl: trimUrl(settings.baseUrl), model: voice.model || sttModel, apiKey: chatKey };
  }
  return null;
}

export function publicVoice(voice, settings, chatKey) {
  const active = resolveVoice(voice, settings, chatKey);
  return {
    available: Boolean(active),
    source: active?.source || null,
    baseUrl: active?.baseUrl || voice.baseUrl || '',
    model: active?.model || voice.model || '',
    hasKey: Boolean(voice.apiKey),
    preset: VOICE_PRESET,
    providers: VOICE_PROVIDERS,
  };
}

const EXT_BY_MIME = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

/** Send the recording to the service. -> {text, latencyMs} */
export async function transcribe(service, bytes, mime = 'audio/webm', { language, timeoutMs = 60000, fetchImpl = fetch } = {}) {
  if (!service) throw voiceError(409, 'VOICE_NOT_CONFIGURED', '还没有配置语音转文字服务');
  if (!bytes?.length) throw voiceError(400, 'EMPTY_AUDIO', '没有录到声音');
  const type = String(mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), `voice.${EXT_BY_MIME[type] || 'webm'}`);
  form.append('model', service.model);
  if (language) form.append('language', language);

  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(`${service.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${service.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw voiceError(502, 'VOICE_UNREACHABLE', `连不上语音服务：${err.name === 'TimeoutError' ? '超时' : err.message}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 200);
    try { const j = JSON.parse(raw); detail = j.error?.message || j.message || detail; } catch { /* text */ }
    const hint = res.status === 401 || res.status === 403 ? 'Key 无效或没有权限' : res.status === 404 ? '这个服务不支持语音转文字，或模型名不对' : `HTTP ${res.status}`;
    throw voiceError(502, 'VOICE_FAILED', `语音转文字失败（${hint}）：${detail}`);
  }
  let text = '';
  try { text = String(JSON.parse(raw).text || ''); } catch { text = raw; }
  // SenseVoice can prefix tags like <|zh|><|NEUTRAL|>; keep only the words.
  text = text.replace(/<\|[^|]*\|>/g, '').trim();
  return { text, latencyMs: Date.now() - started };
}

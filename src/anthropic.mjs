/**
 * anthropic.mjs - Claude, the one big provider that is not OpenAI-compatible.
 *
 * Everything downstream (agent, tools, SSE to the browser) speaks the OpenAI
 * shape, so this file is a translator in both directions:
 *
 *   our messages  ->  { system, messages:[{role, content:[blocks]}] }
 *   tools         ->  [{ name, description, input_schema }]
 *   response      ->  { content, toolCalls:[{id,name,arguments}], finishReason }
 *
 * Streaming is implemented for real (content_block_delta / input_json_delta),
 * because a non-streamed Claude turn on a big tool schema just feels dead.
 */

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function safeJson(raw, fallback = {}) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw || ''));
  } catch {
    return fallback;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

/** Split the system prompt out; Claude takes it as a top-level field. */
function splitSystem(messages = []) {
  const system = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') system.push(textOf(m.content));
    else rest.push(m);
  }
  return { system: system.filter(Boolean).join('\n\n'), rest };
}

function toAnthropicMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: textOf(m.content) }] });
    } else if (m.role === 'assistant') {
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of m.tool_calls || []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name || call.name,
          input: safeJson(call.function?.arguments ?? call.arguments),
        });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: textOf(m.content) || '(empty)',
      };
      const last = out[out.length - 1];
      const lastIsResults = last?.role === 'user'
        && Array.isArray(last.content)
        && last.content.every((c) => c.type === 'tool_result');
      if (lastIsResults) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

function toAnthropicTools(tools = []) {
  return tools
    .map((t) => {
      const fn = t.function || t;
      if (!fn?.name) return null;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    })
    .filter(Boolean);
}

function toOurResult(payload) {
  let text = '';
  const toolCalls = [];
  for (const block of payload.content || []) {
    if (block.type === 'text') text += block.text || '';
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  const usage = payload.usage || {};
  return {
    content: text,
    toolCalls,
    finishReason: payload.stop_reason === 'tool_use' ? 'tool_calls' : (payload.stop_reason || 'stop'),
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

/** POST /messages and translate the SSE stream as it arrives. */
async function streamMessages(cfg, body, { signal, timeoutMs, onDelta }) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/messages`;
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs || cfg.timeoutMs || 120000) : undefined;
  const combined = signal && timeout ? AbortSignal.any?.([signal, timeout]) || timeout : (signal || timeout);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: combined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anthropic HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const blocks = new Map(); // index -> { type, id, name, json }
  let stopReason = 'stop';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let eventName = '';

  const consume = (line) => {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const type = payload.type || eventName;

    if (type === 'message_start') {
      usage.input_tokens = payload.message?.usage?.input_tokens || 0;
    } else if (type === 'content_block_start') {
      const block = payload.content_block || {};
      blocks.set(payload.index, {
        type: block.type,
        id: block.id,
        name: block.name,
        json: '',
        text: block.text || '',
      });
      if (block.type === 'text' && block.text && typeof onDelta === 'function') {
        text += block.text;
        onDelta({ text: block.text });
      }
    } else if (type === 'content_block_delta') {
      const delta = payload.delta || {};
      const entry = blocks.get(payload.index) || {};
      if (delta.type === 'text_delta') {
        text += delta.text || '';
        if (typeof onDelta === 'function' && delta.text) onDelta({ text: delta.text });
      } else if (delta.type === 'input_json_delta') {
        entry.json = (entry.json || '') + (delta.partial_json || '');
        blocks.set(payload.index, entry);
      }
    } else if (type === 'message_delta') {
      stopReason = payload.delta?.stop_reason || stopReason;
      if (payload.usage?.output_tokens) usage.output_tokens = payload.usage.output_tokens;
    }
  };

  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      consume(line);
    }
  }
  if (buffer.trim()) consume(buffer.trim());

  const toolCalls = [];
  for (const entry of blocks.values()) {
    if (entry.type === 'tool_use') {
      toolCalls.push({ id: entry.id, name: entry.name, arguments: entry.json || '{}' });
    }
  }
  return {
    content: text,
    toolCalls,
    finishReason: stopReason === 'tool_use' ? 'tool_calls' : stopReason,
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
  };
}

async function plainMessages(cfg, body, { signal, timeoutMs, onDelta }) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/messages`;
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs || cfg.timeoutMs || 120000) : undefined;
  const combined = signal && timeout ? AbortSignal.any?.([signal, timeout]) || timeout : (signal || timeout);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: combined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anthropic HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }
  const payload = await res.json();
  const result = toOurResult(payload);
  // No real stream: replay the text so the UI still types instead of popping.
  if (typeof onDelta === 'function' && result.content) {
    for (let i = 0; i < result.content.length; i += 24) {
      onDelta({ text: result.content.slice(i, i + 24) });
    }
  }
  return result;
}

export function createAnthropicClient({ baseUrl, apiKey, model, timeoutMs } = {}) {
  const cfg = {
    baseUrl: (baseUrl || env('ASSIST_BASE_URL', 'https://api.anthropic.com/v1')).replace(/\/+$/, ''),
    apiKey: apiKey || env('ASSIST_API_KEY', ''),
    model: model || env('ASSIST_MODEL', 'claude-sonnet-4-5'),
    timeoutMs: timeoutMs || Number(env('ASSIST_MODEL_TIMEOUT_MS', '120000')),
  };

  return {
    ...cfg,
    provider: 'anthropic',
    async complete(messages, opts = {}) {
      const { system, rest } = splitSystem(messages);
      const body = {
        model: cfg.model,
        max_tokens: opts.maxTokens || 4096,
        messages: toAnthropicMessages(rest),
      };
      if (system) body.system = system;
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      const tools = toAnthropicTools(opts.tools);
      if (tools.length) body.tools = tools;
      if (typeof opts.onDelta === 'function') {
        return streamMessages(cfg, body, { signal: opts.signal, timeoutMs: opts.timeoutMs, onDelta: opts.onDelta });
      }
      return plainMessages(cfg, body, { signal: opts.signal, timeoutMs: opts.timeoutMs, onDelta: opts.onDelta });
    },
  };
}

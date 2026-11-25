/**
 * 模型接入层：任何「OpenAI 兼容」的 /chat/completions 端点都能成为一个智能体。
 * 这一层是「桥梁」的物理接口——DeepSeek、OpenAI、OpenRouter、Ollama、LM Studio、
 * 以及任何自建网关，都通过同一套协议接入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { mockStream } from './mock.mjs';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

export function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export const BUILTIN_PROVIDERS = [
  {
    id: 'mock',
    name: '离线模拟器',
    kind: 'mock',
    baseUrl: '',
    env: null,
    models: ['confluence-mock'],
    note: '无需密钥，用于体验与测试',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    env: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: '性价比高，中文表达好',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    env: 'OPENAI_API_KEY',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    note: '',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
    note: '一个密钥接入上百个模型',
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    env: null,
    models: ['qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b'],
    note: '完全离线；需先 ollama serve',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
    env: null,
    models: ['local-model'],
    note: '图形化本地模型服务',
  },
];

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

export class ProviderRegistry {
  constructor({ file } = {}) {
    this.file = file || null;
    this.custom = [];
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.providers)) this.custom = parsed.providers;
    } catch {
      this.custom = [];
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ providers: this.custom }, null, 2));
  }

  /** 内部完整对象（含明文密钥），绝不直接发给浏览器 */
  get(id) {
    if (id === 'mock') {
      const base = BUILTIN_PROVIDERS.find((p) => p.id === 'mock');
      return { ...base, apiKey: null, usable: true };
    }
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id);
    if (builtin) {
      const apiKey = builtin.env ? process.env[builtin.env] || null : null;
      const usable = Boolean(apiKey) || isLocalUrl(builtin.baseUrl) || builtin.kind === 'mock';
      return { ...builtin, apiKey, usable };
    }
    const custom = this.custom.find((p) => p.id === id);
    if (!custom) return null;
    const apiKey = custom.apiKey || (custom.env ? process.env[custom.env] : null) || null;
    return {
      id: custom.id,
      name: custom.name || custom.id,
      kind: 'openai',
      baseUrl: custom.baseUrl,
      models: custom.models?.length ? custom.models : [custom.model].filter(Boolean),
      note: custom.note || '',
      env: null,
      apiKey,
      usable: Boolean(apiKey) || isLocalUrl(custom.baseUrl || ''),
    };
  }

  list() {
    const all = [
      ...BUILTIN_PROVIDERS.map((p) => this.get(p.id)),
      ...this.custom.map((p) => this.get(p.id)).filter(Boolean),
    ];
    return all.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      models: p.models || [],
      note: p.note || '',
      env: p.env || null,
      hasKey: Boolean(p.apiKey),
      keyMask: maskKey(p.apiKey),
      usable: p.usable,
      local: isLocalUrl(p.baseUrl || ''),
      builtin: BUILTIN_PROVIDERS.some((b) => b.id === p.id),
    }));
  }

  upsert(input = {}) {
    const id =
      (input.id || input.name || 'custom')
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 32) || `custom${Date.now().toString(36)}`;
    if (BUILTIN_PROVIDERS.some((p) => p.id === id)) {
      throw new Error('内置提供商请用环境变量配置，不能覆盖 id');
    }
    const exists = this.custom.find((p) => p.id === id);
    const models = (input.models || [])
      .map((m) => String(m).trim())
      .filter(Boolean);
    const entry = {
      id,
      name: input.name || id,
      baseUrl: String(input.baseUrl || '').replace(/\/+$/, ''),
      apiKey: input.apiKey || exists?.apiKey || '',
      models: models.length ? models : exists?.models || [],
      note: input.note || '',
    };
    if (!entry.baseUrl) throw new Error('缺少 baseUrl');
    if (exists) Object.assign(exists, entry);
    else this.custom.push(entry);
    this.save();
    return this.list().find((p) => p.id === id);
  }

  remove(id) {
    const idx = this.custom.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.custom.splice(idx, 1);
    this.save();
    return true;
  }
}

function friendlyError(status, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(body || '').slice(0, 200);
  }
  const hints = {
    401: '密钥无效或没有权限（检查 API Key）',
    403: '密钥被拒绝（检查来源限制或余额）',
    404: '端点不存在（baseUrl 通常应形如 https://api.deepseek.com/v1）',
    429: '触发限流，请稍后再试或换模型',
    500: '上游服务错误',
    502: '上游网关错误',
    503: '上游不可用',
  };
  const hint = hints[status] || '请求失败';
  return new Error(`${hint}${detail ? `：${detail}` : ''}`);
}

/**
 * 流式调用一个 OpenAI 兼容端点。
 * @returns {Promise<{text:string, usage:{prompt:number,completion:number}}>}
 */
export async function streamChat({
  provider,
  model,
  messages,
  temperature = 0.85,
  maxTokens = 900,
  signal,
  onDelta,
  mockContext,
}) {
  if (!provider) throw new Error('提供商不存在');
  if (provider.kind === 'mock') {
    return mockStream({ context: mockContext || {}, onDelta, signal });
  }
  if (!provider.baseUrl) throw new Error(`${provider.name} 缺少 baseUrl`);
  if (!provider.usable) {
    throw new Error(
      `${provider.name} 尚未配置密钥。请设置环境变量 ${provider.env || 'API Key'}，或在「模型」里添加自定义端点。`,
    );
  }

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 180000);
  if (timeout.unref) timeout.unref();

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
    const reason = err?.cause?.code || err?.code || err?.message;
    if (reason === 'ECONNREFUSED') {
      throw new Error(`无法连接 ${provider.baseUrl}（本地服务未启动？）`);
    }
    if (err?.name === 'AbortError') throw err;
    throw new Error(`网络请求失败：${reason}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
    throw friendlyError(res.status, body);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta;
        const piece = delta?.content ?? '';
        if (piece) {
          text += piece;
          onDelta?.(piece);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', onAbort);
  }

  if (!text.trim() && !usage) {
    throw new Error('模型返回了空内容（可能被内容过滤，或该模型不支持流式输出）');
  }

  return {
    text,
    usage: {
      prompt: usage?.prompt_tokens ?? 0,
      completion: usage?.completion_tokens ?? Math.ceil(text.length / 2),
    },
    provider: provider.id,
  };
}

/** 一次性（非流式）调用，用于调度决策等短输出场景 */
export async function completeOnce(opts) {
  return streamChat({ ...opts, maxTokens: opts.maxTokens ?? 260, temperature: opts.temperature ?? 0.2 });
}

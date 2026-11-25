/**
 * 汇流 · Confluence — 本地服务入口。
 * 零依赖：Node 原生 http + 自实现的 WebSocket + 原生 fetch。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { createHub } from './ws.mjs';
import { ProviderRegistry } from './providers.mjs';
import { World } from './world.mjs';
import { PERSONAS, DEFAULT_ROSTER } from './personas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const DATA_DIR = process.env.CONFLUENCE_DATA || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

/* ------------------------------------------------------------------ 存储 */

class JsonStore {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.pending = null;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(data) {
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const payload = this.pending;
      this.pending = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[confluence] 保存世界失败:', err.message);
      }
    }, 250);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    const payload = this.pending;
    this.pending = null;
    if (!payload) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(payload));
    } catch {
      /* noop */
    }
  }

  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* noop */
    }
  }
}

const registry = new ProviderRegistry({ file: PROVIDERS_FILE });
const store = new JsonStore(STATE_FILE);
const hub = createHub();

/** @type {World | null} */
let world = null;

function wireWorld(w) {
  w.on('snapshot', (snapshot) => {
    if (w === world) hub.broadcast({ type: 'snapshot', world: snapshot });
  });
  w.on('event', (event) => {
    if (w === world) hub.broadcast({ type: 'event', event });
  });
}

function loadWorld() {
  const saved = store.load();
  if (!saved) return null;
  try {
    const w = World.fromJSON(saved, { providers: registry, store });
    wireWorld(w);
    return w;
  } catch (err) {
    console.error('[confluence] 恢复世界失败:', err.message);
    return null;
  }
}

world = loadWorld();

/* ------------------------------------------------------------------ 工具 */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { ok: false, error: message });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function statePayload() {
  return {
    ok: true,
    world: world ? world.snapshot() : null,
    providers: registry.list(),
    personas: PERSONAS,
    defaults: { roster: DEFAULT_ROSTER },
    meta: {
      port: PORT,
      version: '1.0.0',
      node: process.version,
      dataDir: DATA_DIR,
      uptime: Math.round(process.uptime()),
    },
  };
}

function requireWorld(res) {
  if (!world) {
    fail(res, 409, '世界尚未创建');
    return null;
  }
  return world;
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.resolve(WEB_ROOT, `.${rel}`);
  if (!filePath.startsWith(WEB_ROOT + path.sep) && filePath !== path.join(WEB_ROOT, 'index.html')) {
    fail(res, 403, 'Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA 兜底：未知路径回首页
      const fallback = path.join(WEB_ROOT, 'index.html');
      fs.readFile(fallback, (e, buf) => {
        if (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ 路由 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  if (!route.startsWith('/api/')) {
    serveStatic(req, res);
    return;
  }

  try {
    if (req.method === 'GET' && route === '/api/state') {
      json(res, 200, statePayload());
      return;
    }

    if (req.method === 'GET' && route === '/api/ping') {
      json(res, 200, { ok: true, ts: Date.now(), clients: hub.size });
      return;
    }

    if (req.method === 'GET' && route === '/api/export') {
      const w = requireWorld(res);
      if (!w) return;
      const md = w.exportMarkdown();
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="confluence-${Date.now()}.md"`,
      });
      res.end(md);
      return;
    }

    if (req.method === 'POST' && route === '/api/world') {
      const body = await readJson(req);
      const goal = String(body.goal || '').trim();
      if (!goal) return fail(res, 400, '请给出世界目标');
      if (world) world.stop('被新世界替换');
      const providerId = body.providerId || 'mock';
      const provider = registry.get(providerId);
      if (!provider) return fail(res, 400, '未知的模型提供商');
      if (!provider.usable) {
        return fail(
          res,
          400,
          `${provider.name} 尚未配置密钥：请设置环境变量 ${provider.env || 'API Key'} 后重启服务，或改用离线模拟器。`,
        );
      }
      const model = body.model || provider.models?.[0] || 'confluence-mock';

      // 每位成员可以绑定不同的端点：逐个校验
      if (Array.isArray(body.agents)) {
        for (const agent of body.agents) {
          const p = registry.get(agent.providerId || providerId);
          if (!p) return fail(res, 400, `未知的模型提供商：${agent.providerId}`);
          if (!p.usable) {
            return fail(
              res,
              400,
              `${p.name} 尚未配置密钥：请设置环境变量 ${p.env || 'API Key'} 后重启服务。`,
            );
          }
        }
      }

      const next = new World({
        title: body.title || deriveTitle(goal),
        goal,
        providers: registry,
        store: { save: (data) => store.save(data) },
        config: body.config || {},
      });

      const customAgents = Array.isArray(body.agents) ? body.agents.filter(Boolean) : [];
      if (customAgents.length) {
        // 完全自定义阵容：每位成员可以有自己的端点与模型
        for (const a of customAgents) {
          next.addAgent({
            ...a,
            providerId: a.providerId || providerId,
            model: a.model || model,
          });
        }
      } else {
        // 角色模板阵容（可用 personaKey 列表裁剪）
        const requested = (Array.isArray(body.roster) && body.roster.length
          ? body.roster
          : DEFAULT_ROSTER
        ).filter((key) => PERSONAS.some((p) => p.key === key));
        const keys = requested.length ? requested : DEFAULT_ROSTER;
        for (const key of keys) {
          const persona = PERSONAS.find((p) => p.key === key);
          if (!persona) continue;
          next.addAgent({
            name: persona.name,
            role: persona.role,
            glyph: persona.glyph,
            color: persona.color,
            personaKey: persona.key,
            isConductor: persona.isConductor,
            providerId,
            model,
          });
        }
      }

      if (next.speakers.length < 1) return fail(res, 400, '至少需要一个可发言的成员');

      world = next;
      wireWorld(next);
      next.start().catch((err) => {
        next.runtime.error = err.message;
      });
      json(res, 200, { ok: true, world: next.snapshot(), providers: registry.list() });
      return;
    }

    if (route.startsWith('/api/world/')) {
      const w = requireWorld(res);
      if (!w) return;
      const action = route.slice('/api/world/'.length);
      const body = await readJson(req).catch(() => ({}));
      if (action === 'start') {
        await w.start();
        return json(res, 200, { ok: true, status: w.runtime.status });
      }
      if (action === 'pause') {
        w.pause();
        return json(res, 200, { ok: true, status: w.runtime.status });
      }
      if (action === 'resume') {
        w.resume();
        return json(res, 200, { ok: true, status: w.runtime.status });
      }
      if (action === 'stop') {
        w.stop(body.reason || '手动停止');
        return json(res, 200, { ok: true, status: w.runtime.status });
      }
      if (action === 'reset') {
        await w.reset({ keepAgents: body.keepAgents !== false });
        return json(res, 200, { ok: true, world: w.snapshot() });
      }
      if (action === 'config') {
        Object.assign(w.config, body || {});
        w.emit('snapshot', w.snapshot());
        return json(res, 200, { ok: true, config: w.config });
      }
      return fail(res, 404, '未知的世界操作');
    }

    if (req.method === 'POST' && route === '/api/message') {
      const w = requireWorld(res);
      if (!w) return;
      const body = await readJson(req);
      const message = w.speakAsHuman(body.text, body.to);
      return json(res, 200, { ok: true, message });
    }

    if (req.method === 'POST' && route === '/api/say') {
      const w = requireWorld(res);
      if (!w) return;
      const body = await readJson(req);
      const result = w.sayAsAgent(body.agent, body.text, body.to);
      return json(res, 200, { ok: true, ...result });
    }

    if (route.startsWith('/api/tasks/')) {
      const w = requireWorld(res);
      if (!w) return;
      const id = route.slice('/api/tasks/'.length);
      const body = await readJson(req);
      w.setTaskStatus(id, body.status);
      return json(res, 200, { ok: true, tasks: w.tasks });
    }

    if (route === '/api/agents' && req.method === 'POST') {
      const w = requireWorld(res);
      if (!w) return;
      const body = await readJson(req);
      const agent = w.addAgent(body);
      return json(res, 200, { ok: true, agent: agentForClient(agent) });
    }

    if (route.startsWith('/api/agents/')) {
      const w = requireWorld(res);
      if (!w) return;
      const id = route.slice('/api/agents/'.length);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const agent = w.updateAgent(id, body);
        return json(res, 200, { ok: true, agent: agentForClient(agent) });
      }
      if (req.method === 'DELETE') {
        w.removeAgent(id);
        return json(res, 200, { ok: true });
      }
    }

    if (route === '/api/providers' && req.method === 'POST') {
      const body = await readJson(req);
      const provider = registry.upsert(body);
      return json(res, 200, { ok: true, provider, providers: registry.list() });
    }

    if (route.startsWith('/api/providers/') && req.method === 'DELETE') {
      const id = route.slice('/api/providers/'.length);
      const removed = registry.remove(id);
      return json(res, 200, { ok: removed });
    }

    fail(res, 404, '接口不存在');
  } catch (err) {
    console.error('[confluence]', err);
    fail(res, 400, err.message || '服务端错误');
  }
});

function deriveTitle(goal) {
  const clean = goal.replace(/\s+/g, ' ').trim();
  const head = clean.split(/[：:，,。；;、]/)[0].trim();
  const base = head.length >= 6 ? head : clean;
  return base.length > 22 ? `${base.slice(0, 22)}…` : base;
}

function agentForClient(a) {
  const { inbox, ...rest } = a;
  return rest;
}

/* ------------------------------------------------------------------ WebSocket */

hub.attach(server, (client, data) => {
  if (data.type === 'hello' || data.type === 'sync') {
    client.send({ type: 'snapshot', world: world ? world.snapshot() : null });
    client.send({ type: 'providers', providers: registry.list() });
    return;
  }
  if (data.type === 'message') {
    try {
      if (!world) throw new Error('世界尚未创建');
      world.speakAsHuman(data.text, data.to);
    } catch (err) {
      client.send({ type: 'error', message: err.message });
    }
    return;
  }
  if (data.type === 'control') {
    if (!world) return;
    const action = data.action;
    if (action === 'start') world.start().catch(() => {});
    else if (action === 'pause') world.pause();
    else if (action === 'resume') world.resume();
    else if (action === 'stop') world.stop();
  }
});

/* ------------------------------------------------------------------ 启动 */

server.listen(PORT, HOST, () => {
  const urlText = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  ✦  汇流 · CONFLUENCE');
  console.log('  ──────────────────────────────────────');
  console.log(`  世界入口   ${urlText}`);
  console.log(`  数据目录   ${DATA_DIR}`);
  console.log(`  模型通道   ${registry.list().filter((p) => p.usable).map((p) => p.name).join(' · ') || '无'}`);
  console.log('  ──────────────────────────────────────');
  console.log('  提示：没有 API Key 也能用「离线模拟器」跑通全流程。');
  console.log('');

  const shouldOpen = process.argv.includes('--open') || process.env.OPEN === '1';
  if (shouldOpen) {
    const cmd =
      process.platform === 'win32'
        ? `start "" "${urlText}"`
        : process.platform === 'darwin'
          ? `open "${urlText}"`
          : `xdg-open "${urlText}"`;
    exec(cmd, () => {});
  }
});

function shutdown() {
  try {
    world?.stop('服务关闭');
  } catch {
    /* noop */
  }
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => console.error('[confluence] uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[confluence] unhandled:', err));

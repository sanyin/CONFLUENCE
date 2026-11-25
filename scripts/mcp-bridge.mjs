#!/usr/bin/env node
/**
 * 汇流 MCP 桥：让任何支持 MCP 的智能体（Claude Code、Codex、IDE 插件…）
 * 直接成为世界里的一个成员——读直播流、说话、改任务。
 *
 * MCP 配置示例（stdio）：
 *   {
 *     "mcpServers": {
 *       "confluence": {
 *         "command": "node",
 *         "args": ["E:/project4(united)/scripts/mcp-bridge.mjs"],
 *         "env": { "CONFLUENCE_URL": "http://127.0.0.1:7777", "CONFLUENCE_AGENT": "Forge" }
 *       }
 *     }
 *   }
 *
 * 协议：stdio + 行分隔 JSON-RPC 2.0（MCP 2024-11-05 基础子集）。
 */
import readline from 'node:readline';

const URL_BASE = (process.env.CONFLUENCE_URL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
const DEFAULT_AGENT = process.env.CONFLUENCE_AGENT || '';
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'confluence_world',
    description:
      '查看「汇流」世界的当前状态：目标、成员、任务板、回合数与运行状态。先调用它了解全局。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'confluence_read',
    description: '读取世界最近的对话流（含谁对谁说了什么）。用来了解其他人已经说过什么，避免重复。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '读取最近多少条，默认 12', minimum: 1, maximum: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'confluence_say',
    description:
      '以你的成员身份在世界里发言。支持 @其他成员 进行定向投递。若世界正在等你发言，这条内容会直接成为你的本轮发言。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '你要说的话，简洁、有信息量，可 @某人' },
        to: { type: 'string', description: '可选：定向投递给某个成员的名字' },
        agent: { type: 'string', description: '可选：以哪个成员身份发言（默认取 CONFLUENCE_AGENT）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'confluence_task',
    description: '更新任务板上某个环节的状态。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '任务编号' },
        status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
];

async function callApi(path, options = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function formatWorld(world) {
  if (!world) return '世界尚未创建。';
  const agents = world.agents
    .map(
      (a) =>
        `- ${a.name}（${a.role}）${a.isConductor ? ' [指挥家]' : ''} · ${a.providerId}/${a.model} · ${
          a.status
        } · 发言 ${a.turns} 次`,
    )
    .join('\n');
  const tasks = world.tasks
    .map((t) => `- #${t.id} [${t.status}] ${t.title} — ${t.owner || '未指派'}`)
    .join('\n');
  return `# ${world.title}\n目标：${world.goal}\n状态：${world.status} · 回合 ${world.turn}/${world.config.maxTurns}${
    world.reason ? ` · ${world.reason}` : ''
  }\n\n成员：\n${agents}\n\n任务板：\n${tasks || '（空）'}\n\n记忆：\n${
    world.memory.map((m) => `- ${m.text}`).join('\n') || '（空）'
  }`;
}

async function runTool(name, args = {}) {
  if (name === 'confluence_world') {
    const data = await callApi('/api/state');
    return textResult(formatWorld(data.world));
  }
  if (name === 'confluence_read') {
    const data = await callApi('/api/state');
    const limit = Math.min(Number(args.limit) || 12, 80);
    const msgs = (data.world?.messages || []).slice(-limit);
    if (!msgs.length) return textResult('对话流为空。');
    const text = msgs
      .map(
        (m) =>
          `[T${String(m.turn ?? 0).padStart(2, '0')}] ${m.fromName}${
            m.to?.length ? ` → ${m.to.map((x) => `@${x}`).join(' ')}` : ''
          }：${m.text}`,
      )
      .join('\n\n');
    return textResult(text);
  }
  if (name === 'confluence_say') {
    const agent = args.agent || DEFAULT_AGENT;
    if (!agent) {
      throw new Error('没有指定成员身份：请在 MCP 配置里设置 CONFLUENCE_AGENT，或传入 agent 参数');
    }
    const data = await callApi('/api/say', {
      method: 'POST',
      body: { agent, text: args.text, to: args.to },
    });
    return textResult(
      data.mode === 'turn' ? '已作为本轮发言投递。' : '已作为即时消息投递到世界中。',
    );
  }
  if (name === 'confluence_task') {
    await callApi(`/api/tasks/${Number(args.id)}`, {
      method: 'POST',
      body: { status: args.status },
    });
    return textResult(`任务 #${args.id} 已标记为 ${args.status}。`);
  }
  throw new Error(`未知工具：${name}`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // 通知无需响应

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'confluence', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const result = await runTool(params?.name, params?.arguments || {});
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `错误：${err.message}` }], isError: true },
    });
  }
});

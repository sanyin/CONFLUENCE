/**
 * 真实网络路径集成测试：起一个假的 OpenAI 兼容端点，
 * 让世界通过真正的 fetch + SSE 流式解析跑完一轮，验证「桥」的物理层。
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { createDefaultWorld } from '../server/world.mjs';
import { ProviderRegistry } from '../server/providers.mjs';

const PORT = 7799;
let chatCalls = 0;
let streamCalls = 0;
const seenHeaders = [];

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    chatCalls += 1;
    seenHeaders.push(req.headers.authorization || '');
    const parsed = JSON.parse(body);
    const system = parsed.messages?.[0]?.content || '';
    const user = parsed.messages?.[1]?.content || '';

    if (system.includes('只输出一个 JSON 对象')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const decision = user.includes('任务板')
        ? JSON.stringify({ next: 'Forge', focus: '给出实现步骤', reason: '轮到工匠' })
        : '';
      sse(res, { choices: [{ delta: { content: decision } }] });
      sse(res, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (system.includes('拆成 3–5 个能推进的环节')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, {
        choices: [
          {
            delta: {
              content: JSON.stringify({
                tasks: [
                  { title: '梳理用户旅程', owner: 'Forge', why: '先看清真实场景' },
                  { title: '设计信息架构', owner: 'Loom', why: '结构决定可用性', after: [1] },
                  { title: '验证关键交互', owner: 'Veritas', why: '别自嗨', after: [1] },
                ],
                opening: '目标已收到，我先拆成三个环节。',
              }),
            },
          },
        ],
      });
      sse(res, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 30 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 普通发言：分三块流式返回
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    streamCalls += 1;
    const parts = ['我先确认数据结构。', '然后把主链路打通。', ' [[task:1 done]] @Veritas 盯着边界。'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < parts.length) {
        sse(res, { choices: [{ delta: { content: parts[i] } }] });
        i += 1;
        return;
      }
      clearInterval(timer);
      sse(res, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 25 } });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 30);
  });
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const registry = new ProviderRegistry({ file: null });
registry.upsert({
  id: 'fake',
  name: 'Fake 端点',
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  models: ['fake-1'],
  apiKey: '',
});

const world = createDefaultWorld({
  title: '网络路径测试',
  goal: '设计一个团队知识库',
  providers: registry,
  store: { save: () => {} },
});
for (const agent of world.agents.values()) {
  agent.providerId = 'fake';
  agent.model = 'fake-1';
}
world.config.maxTurns = 4;
world.config.turnDelayMs = 0;
world.config.finalSummary = false;

console.log('▶ 通过真实 fetch/SSE 跑一个世界…');
await world.start();
await world.loop;

const snap = world.snapshot();
console.log(`  chat 调用: ${chatCalls} · 流式发言: ${streamCalls}`);
console.log(`  状态: ${snap.status} · 消息: ${snap.messages.length} · token: ${snap.usage.completion}`);

assert.ok(chatCalls >= 3, '应当至少调用计划、调度、发言');
assert.ok(streamCalls >= 1, '应当有流式发言');
assert.ok(snap.messages.some((m) => m.text.includes('主链路')), '应当拼出完整流式文本');
assert.ok(snap.messages.some((m) => m.markers?.tasks?.length), '应当解析出任务标记');
assert.ok(snap.tasks.some((t) => t.status === 'done'), '任务应被标记完成');
assert.ok(snap.tasks.some((t) => t.dependsOn?.length), '应当解析出环节依赖');
assert.ok(
  snap.tasks.filter((t) => t.status === 'done').every((t) => t.artifact),
  '完成的环节应当写入交接凭据',
);
assert.ok(snap.usage.completion > 0, '应当累计 token 用量');
assert.equal(seenHeaders[0], '', '本地端点不应强制 Authorization');

console.log('✓ 网络路径与 SSE 解析正常');
server.close();

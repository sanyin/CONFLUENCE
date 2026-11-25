/**
 * 无依赖的端到端冒烟测试：用离线模拟器跑完一个世界，
 * 校验发言、@提及、任务板、记忆、收尾产出与结束状态。
 */
import assert from 'node:assert/strict';
import { createDefaultWorld } from '../server/world.mjs';
import { ProviderRegistry } from '../server/providers.mjs';

const registry = new ProviderRegistry({ file: null });
let saves = 0;

const world = createDefaultWorld({
  title: '冒烟测试',
  goal: '为一款面向独立开发者的记账 App 设计技术方案，并给出 4 周落地计划。',
  providers: registry,
  store: { save: () => (saves += 1) },
});

for (const agent of world.agents.values()) {
  agent.providerId = 'mock';
  agent.model = 'confluence-mock';
}

world.config.maxTurns = 10;
world.config.turnDelayMs = 0;
world.config.moderator = 'llm';

const deltas = [];
world.on('event', (ev) => {
  if (ev.t === 'delta') deltas.push(ev.text);
});

console.log('▶ 启动世界…');
await world.start();
await world.loop;

const snap = world.snapshot();
console.log(`  状态: ${snap.status} · 结束原因: ${snap.reason}`);
console.log(`  发言数: ${snap.messages.length} · 任务: ${snap.tasks.length} · 记忆: ${snap.memory.length}`);
console.log(`  回合: ${snap.turn} · 保存次数: ${saves} · 流式片段: ${deltas.length}`);
if (snap.error) console.log(`  错误: ${snap.error}`);
console.log(
  `  任务: ${snap.tasks
    .map(
      (t) =>
        `#${t.id}${t.dependsOn?.length ? `←${t.dependsOn.join(',')}` : ''}[${t.status}]${
          t.artifact ? '·有交接' : ''
        }`,
    )
    .join(' ')}`,
);

assert.equal(snap.status, 'done', '世界应当结束');
assert.ok(snap.messages.length >= 3, '应当有多次发言');
assert.ok(snap.tasks.length >= 3, '应当生成任务板');
assert.ok(snap.messages.some((m) => m.kind === 'plan'), '应当有开场计划');
assert.ok(deltas.length > 10, '应当有流式输出');
assert.ok(snap.messages.some((m) => m.kind === 'final'), '应当产出最终交付物');
assert.ok(
  snap.messages.some((m) => m.to?.length),
  '应当至少出现一次 @提及 定向投递',
);
assert.ok(snap.agents.every((a) => a.status === 'idle'), '结束后所有成员应回到 idle');

// 交接与依赖
assert.ok(snap.tasks.some((t) => t.dependsOn?.length), '计划应当包含先后依赖');
assert.ok(
  snap.tasks.filter((t) => t.status === 'done').every((t) => t.artifact),
  '完成的环节应当有交接凭据',
);
assert.ok(
  snap.tasks.every(
    (t) =>
      t.status !== 'done' ||
      (t.dependsOn || []).every((id) => snap.tasks.find((x) => x.id === id)?.status === 'done'),
  ),
  '不应出现前置未完成却被标记完成的环节',
);

// 冲突拦截：非负责人不能代完成
const victim = snap.tasks.find((t) => t.status !== 'done') || snap.tasks[0];
victim.status = 'todo';
victim.owner = 'Forge';
victim.dependsOn = [];
world.sayAsAgent('Veritas', `我替 Forge 把这个环节收掉 [[task:${victim.id} done]]`);
assert.notEqual(world.tasks.find((t) => t.id === victim.id).status, 'done', '非负责人代完成应被拒绝');
assert.ok(
  world.logs.some((l) => l.text.includes('交接冲突')),
  '应当记录交接冲突',
);

// 依赖拦截：前置未交付不能完成
const dependent = world.tasks.find((t) => t.dependsOn?.length);
if (dependent) {
  dependent.status = 'todo';
  dependent.owner = 'Forge';
  const dep = world.tasks.find((x) => x.id === dependent.dependsOn[0]);
  if (dep) dep.status = 'todo';
  world.sayAsAgent('Forge', `这个我完成了 [[task:${dependent.id} done]]`);
  assert.notEqual(
    world.tasks.find((t) => t.id === dependent.id).status,
    'done',
    '前置未交付时不应允许完成',
  );
}

// 任务板状态应当发生推进
const progressed = snap.tasks.some((t) => t.status === 'done' || t.status === 'doing');
assert.ok(progressed, '任务应当被推进');

// 人类插话 + 私信
const before = world.messages.length;
world.speakAsHuman('请大家优先保证可交付性，不要发散。', 'Forge');
assert.equal(world.messages.length, before + 1, '人类消息应当写入');
assert.ok(world.messages.at(-1).to.includes('Forge'), '人类消息应当定向到 Forge');

// 外部成员桥接
world.addAgent({
  name: 'Remote',
  role: '外部工具',
  glyph: '⇄',
  color: '#9FB4C7',
  kind: 'external',
  providerId: 'mock',
  model: 'confluence-mock',
});
const res = world.sayAsAgent('Remote', '我来自另一个程序的桥接消息。', 'Forge');
assert.equal(res.delivered, true, '外部成员应当可以投递');
assert.ok(world.messages.at(-1).fromName === 'Remote', '外部消息来源应当是 Remote');

// 导出与序列化
const md = world.exportMarkdown();
assert.ok(md.includes('## 任务板'), '导出应包含任务板');
assert.ok(md.includes('## 对话实录'), '导出应包含对话');

const { World } = await import('../server/world.mjs');
const restored = World.fromJSON(JSON.parse(JSON.stringify(world.toJSON())), {
  providers: registry,
  store: { save: () => {} },
});
assert.equal(restored.messages.length, world.messages.length, '恢复后消息数应一致');
assert.equal(restored.agents.size, world.agents.size, '恢复后成员数应一致');

// 暂停 / 继续：主循环必须在 resume 后继续推进（回归测试）
const w2 = createDefaultWorld({
  title: '暂停测试',
  goal: '设计一个可维护的配置系统',
  providers: registry,
  store: { save: () => {} },
});
for (const agent of w2.agents.values()) {
  agent.providerId = 'mock';
  agent.model = 'confluence-mock';
}
w2.config.maxTurns = 8;
w2.config.turnDelayMs = 0;
await w2.start();
await new Promise((r) => setTimeout(r, 250));
w2.pause();
const pausedTurn = w2.runtime.turn;
await new Promise((r) => setTimeout(r, 250));
w2.resume();
await w2.loop;
assert.ok(
  w2.runtime.turn > pausedTurn,
  `暂停后继续应当推进回合（暂停时 ${pausedTurn}，结束于 ${w2.runtime.turn}）`,
);
assert.ok(w2.runtime.status === 'done', '继续后应当正常结束');

console.log('✓ 全部断言通过');

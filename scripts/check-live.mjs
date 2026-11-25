/**
 * 实时通道自检：连接 WebSocket，统计事件类型，验证快照/增量/流式文本。
 * 用法：node scripts/check-live.mjs [url] [秒数]
 */
const url = (process.argv[2] || 'http://127.0.0.1:7777').replace(/\/+$/, '');
const seconds = Number(process.argv[3] || 12);
const wsUrl = url.replace(/^http/, 'ws') + '/ws';

const counts = {};
let lastWorld = null;
let deltas = 0;
let deltaChars = 0;

const ws = new WebSocket(wsUrl);

ws.addEventListener('open', () => {
  console.log('✓ WebSocket 已连接');
  ws.send(JSON.stringify({ type: 'sync' }));
});

ws.addEventListener('message', (evt) => {
  const msg = JSON.parse(evt.data);
  counts[msg.type] = (counts[msg.type] || 0) + 1;
  if (msg.type === 'snapshot' && msg.world) lastWorld = msg.world;
  if (msg.type === 'event') {
    const t = msg.event.t;
    counts[`event:${t}`] = (counts[`event:${t}`] || 0) + 1;
    if (t === 'delta') {
      deltas += 1;
      deltaChars += (msg.event.text || '').length;
    }
  }
});

ws.addEventListener('error', (e) => console.log('✕ 连接错误', e.message || ''));

setTimeout(() => {
  console.log('事件统计:', counts);
  console.log(
    `快照: ${lastWorld ? `${lastWorld.status} · 回合 ${lastWorld.turn} · 消息 ${lastWorld.messages.length}` : '无'}`,
  );
  console.log(`流式片段: ${deltas} 个 / ${deltaChars} 字符`);
  ws.close();
  const ok = counts.snapshot > 0 && (lastWorld?.messages.length || 0) > 0;
  console.log(ok ? '✓ 实时通道正常' : '✕ 未收到足够数据');
  process.exit(ok ? 0 : 1);
}, seconds * 1000);

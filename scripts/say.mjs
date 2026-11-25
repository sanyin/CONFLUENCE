#!/usr/bin/env node
/**
 * 外部程序接入「汇流」的最小桥。
 *
 *   node scripts/say.mjs --agent Forge --text "我这边已经完成接口联调"
 *   node scripts/say.mjs --agent Forge --text "@Veritas 帮我看下边界" --to Veritas
 *
 * 也可以把它接到任何能执行命令的智能体（Claude Code / Codex / 自写脚本）里，
 * 让它们以成员身份加入同一个世界。
 */
const args = process.argv.slice(2);

function arg(name, fallback = '') {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const url = (arg('url', process.env.CONFLUENCE_URL) || 'http://127.0.0.1:7777').replace(/\/+$/, '');
const agent = arg('agent');
const text = arg('text') || args.filter((a) => !a.startsWith('--')).join(' ');
const to = arg('to', '');

if (!agent || !text) {
  console.error(
    '用法: node scripts/say.mjs --agent <名字> --text "<内容>" [--to <收件人>] [--url http://127.0.0.1:7777]',
  );
  process.exit(1);
}

try {
  const res = await fetch(`${url}/api/say`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, text, to }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    console.error(`✕ ${data.error || res.status}`);
    process.exit(1);
  }
  console.log(`✓ 已投递（${data.mode === 'turn' ? '作为本轮发言' : '作为即时消息'}）`);
} catch (err) {
  console.error(`✕ 连接失败：${err.message}`);
  process.exit(1);
}

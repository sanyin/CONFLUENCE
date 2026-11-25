/**
 * 离线模拟器：没有 API Key 也能把「汇流」跑起来。
 * 它不是随机废话——会读目标、任务板与上一条发言，产出连贯的协作内容，
 * 并且遵守与真实模型相同的标记协议，方便端到端测试。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seedStr) {
  let s = hash(seedStr) % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];

const DOMAINS = {
  code: {
    ideas: ['先定义一个能跑通的最小闭环，再逐层加厚', '把状态收敛到单一数据源，前端只做投影', '用一条端到端路径把所有模块串起来验证'],
    risks: ['并发写入会互相覆盖', '错误路径没有被任何一次运行覆盖到', '接口契约只写在文档里，没有可执行断言'],
    steps: ['定下数据结构与接口形状', '实现主链路并打日志', '补异常分支与重试', '用一次真实调用做验收'],
  },
  research: {
    ideas: ['把问题拆成可证伪的子假设', '先找出与直觉相反的证据', '用一个对照实验代替长篇论证'],
    risks: ['结论依赖了未经验证的中间假设', '样本选择本身带来了偏差', '证据只支持相关性，却被写成因果'],
    steps: ['确定评估口径', '收集一手证据', '交叉检验矛盾点', '写出可复核的结论'],
  },
  writing: {
    ideas: ['先定读者与要改变的那一个认知', '用一条主线穿起所有素材', '把最锋利的句子放在开头'],
    risks: ['信息密度低，读三句就知道结论', '论据与主张之间缺一步推理', '语气与读者身份不匹配'],
    steps: ['确定核心主张', '搭出论证骨架', '填充证据与例子', '压缩到没有一句可删'],
  },
  product: {
    ideas: ['先确认这是谁的高频痛点', '把完整流程压缩到三步以内', '用一个可感知的反馈制造留存'],
    risks: ['把一次性需求当成长期需求', '首次使用门槛过高导致流失', '价值主张无法被一句话说清'],
    steps: ['拆出用户旅程', '定义最小可用版本', '设计关键反馈', '找 5 个真实用户验证'],
  },
  general: {
    ideas: ['先把目标翻译成可检验的完成标准', '把大问题拆成互不依赖的小块', '先做一个粗糙但完整的版本'],
    risks: ['大家对"完成"的定义并不一致', '关键约束被忽略', '当前方案假设了不存在的资源'],
    steps: ['澄清目标与约束', '列出可选路径', '选择一条并推进', '复盘并收敛结论'],
  },
};

function domainOf(goal = '') {
  if (/代码|编程|开发|实现|重构|bug|系统|网站|应用|api|工程/i.test(goal)) return 'code';
  if (/研究|论文|调研|分析|实验|假设|文献/i.test(goal)) return 'research';
  if (/写|文档|文案|文章|报告|故事|脚本|翻译/i.test(goal)) return 'writing';
  if (/产品|用户|增长|运营|设计|体验|需求/i.test(goal)) return 'product';
  return 'general';
}

function short(str = '', n = 42) {
  const clean = String(str).replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

function peersOf(context) {
  return (context.peers || []).filter((p) => p && p.name);
}

function otherPeers(context, r) {
  const list = peersOf(context).filter((p) => p.name !== context.name && !p.isConductor);
  return list.length ? pick(r, list) : null;
}

function topicOf(focus) {
  const raw = String(focus || '').replace(/\s+/g, ' ').trim();
  const quoted = raw.match(/[「『]([^」』]+)[」』]/);
  if (quoted) return quoted[1];
  return raw || '当前问题';
}

function afterFor(index) {
  if (index === 0) return [];
  if (index === 1) return [1];
  if (index === 2) return [1];
  if (index === 3) return [3];
  if (index === 4) return [2, 4];
  return [5];
}

function makePlan(context) {
  const r = rng(`plan:${context.goal}:${context.turn}`);
  const domain = DOMAINS[domainOf(context.goal)];
  const peers = peersOf(context).filter((p) => !p.isConductor);
  const titles = [
    '澄清目标与验收标准',
    ...domain.steps.slice(0, 3).map((s) => s[0].toUpperCase() + s.slice(1)),
    '整合产出并复核',
  ];
  const tasks = titles.slice(0, Math.max(3, Math.min(5, titles.length))).map((title, i) => ({
    title,
    owner: peers.length ? peers[i % peers.length].name : undefined,
    why: i === 0 ? '先把"完成"定义清楚，后面才不会各说各话' : '让讨论落到可交付的环节上',
    after: afterFor(i),
  }));
  const opening = `人类给出的目标是：${short(context.goal, 80)}。我把它拆成 ${tasks.length} 个环节，有先后依赖，请按交接顺序推进；有分歧就当场对齐。`;
  return { tasks, opening };
}

function makeSelection(context) {
  const r = rng(`sel:${context.turn}:${context.goal}`);
  const tasks = context.tasks || [];
  const ready = tasks.filter(
    (t) =>
      t.status !== 'done' &&
      (t.dependsOn || []).every((id) => tasks.find((x) => x.id === id)?.status === 'done'),
  );
  const pending = tasks.filter((t) => t.status !== 'done');
  const maxTurns = context.maxTurns || 24;
  if (!pending.length) {
    return { next: 'DONE', reason: '任务板已全部完成，可以收束了' };
  }
  if (!ready.length) {
    return { next: 'DONE', reason: '所有剩余环节都在等待前置产出，先收尾' };
  }
  const spoken = new Set(context.spoken || []);
  const notYet = peersOf(context).filter((p) => !p.isConductor && !spoken.has(p.name));
  // 开头两轮先补齐不同视角，之后把发言权交回给可推进环节的负责人
  if (notYet.length && context.turn >= 1 && context.turn <= 2) {
    const p = pick(r, notYet);
    const openTask = ready[0];
    return {
      next: p.name,
      focus: openTask
        ? `推进「${openTask.title}」，用${p.role}的视角补一个关键点`
        : `用${p.role}的视角补一个还没人提到的关键点`,
      reason: '还有人没有表态，先补齐视角',
    };
  }
  const active = ready.find((t) => t.status === 'doing') || ready[0];
  let owner =
    active.owner && peersOf(context).some((p) => p.name === active.owner)
      ? active.owner
      : peersOf(context).filter((p) => !p.isConductor)[0]?.name ?? 'DONE';
  if (owner === context.lastSpeaker) {
    const alt = peersOf(context).filter(
      (p) => !p.isConductor && p.name !== context.lastSpeaker,
    );
    if (alt.length) owner = pick(r, alt).name;
  }
  // 只有临近回合上限才考虑收尾，避免任务还没推进就结束
  if (context.turn >= maxTurns - 1) {
    return { next: 'DONE', reason: '已接近回合上限，进入收尾' };
  }
  return {
    next: owner,
    focus: `推进「${active.title}」：给出下一步具体动作`,
    reason: `任务 #${active.id} 已就绪，尚未完成`,
  };
}

function makeAgentReply(context) {
  const r = rng(`${context.name}:${context.turn}:${context.focus || ''}`);
  const domain = DOMAINS[domainOf(context.goal)];
  const focus = context.focus || '当前问题';
  const last = (context.recent || []).filter((m) => m.fromName !== context.name).slice(-1)[0];
  const quote = last ? short(last.text, 26) : '';
  const peer = otherPeers(context, r);
  const mention = peer ? `@${peer.name} ` : '';
  const role = context.roleKey || 'general';

  if (role === 'critic') {
    const risk = pick(r, domain.risks);
    const opener = pick(r, ['先泼一点冷水：', '我担心的是：', '这里有个容易被忽略的反例：']);
    const lead = quote
      ? `刚才「${quote}」里有一个没被检验的默认假设：${risk}。`
      : `${opener}${risk}。`;
    return `${lead}\n建议先用一个最小验证把它压下去，再谈扩展。${mention}你觉得这个验证要怎么设计？`;
  }

  if (role === 'weaver') {
    const a = pick(r, domain.steps);
    const b = pick(r, domain.ideas);
    const opener = pick(r, ['我把目前的共识收一下：', '先对齐已经确认的部分：', '现在的分歧其实只剩一处：']);
    return `${opener}一是${a}；二是${b}。\n我倾向于先做能立刻被验证的那一步，其余的排进下一轮。[[remember: 收敛原则：先跑通最小闭环，再扩展]]`;
  }

  if (role === 'scout') {
    const idea = pick(r, domain.ideas);
    const step = pick(r, domain.steps);
    const opener = pick(r, ['换一个角度：', '我先抛一个不同的方向：', '往后退一步看：']);
    return `${opener}${idea}。\n具体可以这样落地——${step}。${mention}这条路上最大的暗礁是什么？`;
  }

  // builder / default
  const steps = domain.steps;
  const s1 = steps[0];
  const s2 = steps[1] || steps[0];
  const s3 = steps[2] || steps[0];
  const topic = topicOf(focus);
  const opener = pick(r, ['我给出可执行的三步：', '落到动作上：', '我会这样拆：']);
  return `围绕「${short(topic, 26)}」，${opener}\n1) ${s1}；2) ${s2}；3) ${s3}。\n${mention}请重点盯第 2 步的边界条件，那里最容易返工。`;
}

function applyMarkers(text, context) {
  const r = rng(`mark:${context.name}:${context.turn}`);
  const all = context.tasks || [];
  // 只宣告「自己的、前置已交付的」环节，避免制造交接冲突
  const owned = (context.ownedTasks || []).filter(
    (t) =>
      t.status !== 'done' &&
      (t.dependsOn || []).every((id) => all.find((x) => x.id === id)?.status === 'done'),
  );
  let out = text;
  // 负责人有较大概率在本次发言中交付，保留少量"继续打磨"的回合
  if (owned.length && r() > 0.45) {
    out += `\n[[task:${owned[0].id} done]]`;
  } else if (r() > 0.84) {
    out += `\n[[remember: ${pick(r, DOMAINS[domainOf(context.goal)].ideas)}]]`;
  }
  return out;
}

function makeFinal(context) {
  const domain = DOMAINS[domainOf(context.goal)];
  const tasks = (context.tasks || [])
    .map((t) => `- ${t.title}${t.owner ? `（${t.owner}）` : ''}`)
    .join('\n');
  const delivered = (context.tasks || [])
    .filter((t) => t.artifact)
    .map((t) => `- #${t.id} ${t.title}（${t.artifact.by}）：${short(t.artifact.text, 110)}`)
    .join('\n');
  return `## 结论
围绕「${short(context.goal, 46)}」，建议采用**分阶段推进**：先跑通最小闭环，再用真实反馈决定扩展方向。

## 方案要点
1. ${domain.steps[0]}。
2. ${domain.steps[1]}。
3. ${domain.steps[2]}。
4. 用一次真实调用做验收，避免只在纸面上成立。

## 已推进的环节
${tasks || '- （无）'}

## 交接记录
${delivered || '- 暂无交接'}

## 主要风险
- ${domain.risks[0]}。
- ${domain.risks[1]}。

## 接下来的动作
- 本周：${domain.steps[0]}，产出一个可演示的最小版本。
- 下周：${domain.steps[1]}，补齐异常与边界。
- 验收标准：真实用户能独立走完一次完整流程。`;
}

export function mockText(context = {}) {
  const kind = context.kind || 'agent';
  if (kind === 'plan') {
    const plan = makePlan(context);
    return JSON.stringify(plan);
  }
  if (kind === 'select') {
    return JSON.stringify(makeSelection(context));
  }
  if (kind === 'final') {
    return makeFinal(context);
  }
  return applyMarkers(makeAgentReply(context), context);
}

export async function mockStream({ context, onDelta, signal }) {
  const full = mockText(context);
  const chunks = full.match(/[\s\S]{1,9}/g) || [full];
  for (const chunk of chunks) {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    await sleep(12 + Math.random() * 18);
    onDelta?.(chunk);
  }
  return {
    text: full,
    usage: { prompt: 0, completion: Math.ceil(full.length / 2) },
    provider: 'mock',
  };
}

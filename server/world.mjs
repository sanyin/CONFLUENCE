/**
 * 世界引擎：一个由多个智能体组成的、共享同一份上下文的协作空间。
 *
 * 设计取舍（对照 AgentWeave / Agora / Tutti 等项目的经验）：
 * - 不做 Electron、不做数据库：单进程内存态 + JSON 快照，随时可恢复。
 * - 不做「自由群聊」：由指挥家（conductor）显式调度，避免噪声淹没任务。
 * - 通讯是真正双向的：@提及、私信收件箱、外部程序作为成员接入。
 * - 共享状态只有三样：任务板、长期记忆、对话流。足够，也够快。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { streamChat, completeOnce } from './providers.mjs';
import {
  agentSystemPrompt,
  CONDUCTOR_SYSTEM,
  PLAN_SYSTEM,
  PROTOCOL,
  PERSONAS,
  DEFAULT_ROSTER,
} from './personas.mjs';

const uid = (prefix) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n) => {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
};

export const DEFAULT_CONFIG = {
  maxTurns: 24,
  turnDelayMs: 900,
  maxTokens: 800,
  externalTimeoutMs: 20000,
  moderator: 'llm', // llm | rules
  finalSummary: true,
  temperature: 0.85,
};

/** 从模型输出里抠出第一个完整 JSON 对象 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : String(text);
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 解析发言中的 [[task:1 done]] / [[remember: ...]] / [[goal:done]] 标记 */
export function parseMarkers(raw) {
  let text = String(raw ?? '');
  const tasks = [];
  const memories = [];
  let goalDone = false;

  text = text.replace(
    /\[\[\s*task\s*[:：]?\s*(\d+)\s*[:：]?\s*(done|finished|complete|completed|完成|blocked|阻塞|卡住)\s*(?:[:：]\s*([^\]]*))?\]\]/gi,
    (_m, id, state, note) => {
      const done = /done|finished|complete|完成/i.test(state);
      tasks.push({ id: Number(id), status: done ? 'done' : 'blocked', note: (note || '').trim() });
      return '';
    },
  );
  text = text.replace(/\[\[\s*remember\s*[:：]\s*([\s\S]*?)\]\]/gi, (_m, body) => {
    if (body.trim()) memories.push(body.trim());
    return '';
  });
  text = text.replace(/\[\[\s*goal\s*[:：]?\s*(done|完成|达成)\s*\]\]/gi, () => {
    goalDone = true;
    return '';
  });
  // 未知标记一律剔除，避免泄露到界面
  text = text.replace(/\[\[\s*[a-zA-Z_]+\s*[:：][\s\S]*?\]\]/g, '');

  return {
    text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    tasks,
    memories,
    goalDone,
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class World extends EventEmitter {
  constructor({ title, goal, providers, store, config } = {}) {
    super();
    this.id = uid('w_');
    this.title = title || '未命名世界';
    this.goal = goal || '';
    this.createdAt = Date.now();
    this.startedAt = null;
    this.endedAt = null;
    this.providers = providers;
    this.store = store || null;

    this.agents = new Map();
    this.messages = [];
    this.tasks = [];
    this.memory = [];
    this.logs = [];
    this.summary = null;
    this.seq = 0;

    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.runtime = {
      status: 'idle', // idle | running | paused | done | error
      turn: 0,
      reason: null,
      error: null,
      awaiting: null,
      abort: null,
      consecutiveErrors: 0,
      goalDone: false,
      priorityAgentId: null,
      priorityFocus: null,
    };
    this.loopActive = false;
    this.loop = null;
    this.generation = 0;
    this.usage = { prompt: 0, completion: 0, calls: 0 };
  }

  /* ------------------------------------------------------------------ 成员 */

  get conductor() {
    return [...this.agents.values()].find((a) => a.isConductor) || null;
  }

  get speakers() {
    return [...this.agents.values()].filter((a) => !a.isConductor);
  }

  getAgentByName(name) {
    if (!name) return null;
    const target = String(name).trim().replace(/^@/, '').toLowerCase();
    for (const agent of this.agents.values()) {
      if (agent.name.toLowerCase() === target) return agent;
    }
    for (const agent of this.agents.values()) {
      if (agent.role && agent.role.toLowerCase() === target) return agent;
    }
    for (const agent of this.agents.values()) {
      if (agent.name.toLowerCase().includes(target) && target.length >= 2) return agent;
    }
    return null;
  }

  addAgent(input = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('成员需要名字');
    if (this.getAgentByName(name)) throw new Error(`成员 ${name} 已存在`);
    const wantsConductor = Boolean(
      input.isConductor ?? PERSONAS.find((p) => p.key === input.personaKey)?.isConductor,
    );
    if (wantsConductor && this.conductor) throw new Error('这个世界已经有指挥家了');
    if (!/^[\w\u4e00-\u9fa5·-]{1,20}$/u.test(name)) {
      throw new Error('名字只能包含中英文、数字、下划线与连字符（≤20 字符）');
    }
    const persona =
      PERSONAS.find((p) => p.key === input.personaKey) || PERSONAS.find((p) => p.name === name) || null;
    const agent = {
      id: uid('a_'),
      name,
      role: input.role || persona?.role || '成员',
      glyph: input.glyph || persona?.glyph || name.slice(0, 1).toUpperCase(),
      color: input.color || persona?.color || '#9FB4C7',
      personaKey: input.personaKey || persona?.key || 'custom',
      isConductor: Boolean(input.isConductor ?? persona?.isConductor),
      kind: input.kind === 'external' ? 'external' : 'llm',
      providerId: input.providerId || this.providers?.list()?.find((p) => p.usable)?.id || 'mock',
      model: input.model || '',
      temperature: Number.isFinite(input.temperature) ? input.temperature : this.config.temperature,
      system: input.system || '',
      status: 'idle',
      turns: 0,
      chars: 0,
      lastLine: '',
      lastTurnAt: null,
      inbox: [],
    };
    if (!agent.model) {
      const provider = this.providers?.get(agent.providerId);
      agent.model = provider?.models?.[0] || 'confluence-mock';
    }
    this.agents.set(agent.id, agent);
    this.#log('info', `${agent.name}（${agent.role}）加入了世界`);
    this.#emitSnapshot();
    this.#save();
    return agent;
  }

  updateAgent(id, patch = {}) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('成员不存在');
    if (patch.name && patch.name !== agent.name) {
      if (this.getAgentByName(patch.name)) throw new Error('名字已被占用');
      agent.name = String(patch.name).trim();
    }
    for (const key of ['role', 'glyph', 'color', 'providerId', 'model', 'system', 'personaKey']) {
      if (typeof patch[key] === 'string' && patch[key] !== '') agent[key] = patch[key];
    }
    if (typeof patch.temperature === 'number') agent.temperature = patch.temperature;
    if (typeof patch.isConductor === 'boolean') agent.isConductor = patch.isConductor;
    if (patch.kind === 'llm' || patch.kind === 'external') agent.kind = patch.kind;
    if (!agent.model) {
      agent.model = this.providers?.get(agent.providerId)?.models?.[0] || 'confluence-mock';
    }
    this.#emitSnapshot();
    this.#save();
    return agent;
  }

  removeAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (this.agents.size <= 2) throw new Error('至少保留两个成员');
    this.agents.delete(id);
    for (const t of this.tasks) {
      if (t.owner === agent.name) t.owner = '';
    }
    this.#log('warn', `${agent.name} 离开了世界`);
    this.#emitSnapshot();
    this.#save();
    return true;
  }

  /* ------------------------------------------------------------------ 生命周期 */

  async start() {
    if (this.runtime.status === 'running') return;
    if (!this.goal.trim()) throw new Error('世界还没有目标');
    if (this.speakers.length < 1) throw new Error('至少需要一个可发言的成员');

    // 已经结束过（含结束后人类单独对话）再次启动 = 开新一轮
    const wasFinished =
      this.runtime.status === 'done' ||
      this.runtime.status === 'error' ||
      this.runtime.goalDone ||
      Boolean(this.runtime.reason);
    if (wasFinished) {
      this.tasks = [];
      this.runtime.turn = 0;
      this.runtime.goalDone = false;
      this.runtime.reason = null;
      this.summary = null;
      this.#log('info', '开启新一轮协作');
    }

    this.runtime.status = 'running';
    this.runtime.reason = null;
    this.runtime.error = null;
    this.runtime.consecutiveErrors = 0;
    this.runtime.goalDone = false;
    this.startedAt = this.startedAt || Date.now();
    this.endedAt = null;
    this.#log('info', `世界启动：${short(this.goal, 60)}`);
    this.#emitSnapshot();
    this.#save();

    this.generation += 1;
    const generation = this.generation;
    this.loop = this.#run(generation);
  }

  pause() {
    if (this.runtime.status !== 'running') return;
    this.runtime.status = 'paused';
    this.#log('info', '已暂停');
    this.#emitSnapshot();
    this.emit('event', { t: 'status', status: 'paused' });
  }

  resume() {
    if (this.runtime.status !== 'paused') return;
    this.runtime.status = 'running';
    this.#log('info', '继续运行');
    this.#emitSnapshot();
    this.runtime.resumeResolve?.();
    this.runtime.resumeResolve = null;
    this.emit('event', { t: 'status', status: 'running' });
    // 若循环已经在暂停时退出（例如暂停发生在一轮结束的边界），重新拉起
    if (!this.loopActive) {
      this.loop = this.#run(this.generation);
    }
  }

  stop(reason = '手动停止') {
    const wasActive = this.runtime.status === 'running' || this.runtime.status === 'paused';
    this.generation += 1;
    this.runtime.abort?.abort();
    this.runtime.awaiting?.cancel?.();
    this.runtime.awaiting = null;
    this.runtime.resumeResolve?.();
    this.runtime.resumeResolve = null;
    if (!wasActive) return;
    this.runtime.status = 'done';
    this.runtime.reason = reason;
    this.endedAt = Date.now();
    this.#log('warn', `世界结束：${reason}`);
    this.#emitSnapshot();
    this.#save();
  }

  async reset({ keepAgents = true } = {}) {
    this.stop('重置');
    this.messages = [];
    this.tasks = [];
    this.memory = [];
    this.logs = [];
    this.summary = null;
    this.seq = 0;
    this.usage = { prompt: 0, completion: 0, calls: 0 };
    this.runtime = {
      status: 'idle',
      turn: 0,
      reason: null,
      error: null,
      awaiting: null,
      abort: null,
      consecutiveErrors: 0,
      goalDone: false,
      priorityAgentId: null,
      priorityFocus: null,
    };
    this.startedAt = null;
    this.endedAt = null;
    for (const agent of this.agents.values()) {
      agent.status = 'idle';
      agent.turns = 0;
      agent.chars = 0;
      agent.lastLine = '';
      agent.inbox = [];
      agent.lastTurnAt = null;
    }
    if (!keepAgents) this.agents.clear();
    this.#log('info', '世界已重置');
    this.#emitSnapshot();
    this.#save();
  }

  /* ------------------------------------------------------------------ 主循环 */

  async #run(generation) {
    this.loopActive = true;
    try {
      await this.#runLoop(generation);
    } catch (err) {
      this.runtime.status = 'error';
      this.runtime.error = err.message;
      this.#log('error', `运行中断：${err.message}`);
      this.#emitSnapshot();
    } finally {
      this.loopActive = false;
    }
  }

  async #runLoop(generation) {
    if (!this.tasks.length) await this.#makePlan();
    if (!this.tasks.length) throw new Error('无法生成任务计划');

    while (
      this.generation === generation &&
      (this.runtime.status === 'running' || this.runtime.status === 'paused')
    ) {
      if (this.runtime.turn >= this.config.maxTurns) {
        await this.#finish('已到达回合上限');
        return;
      }
      if (this.runtime.status === 'paused') await this.#waitResume();
      if (this.generation !== generation) return;
      if (this.runtime.status !== 'running') return;

      if (this.runtime.goalDone) {
        await this.#finish('目标已达成');
        return;
      }

      const decision = await this.#chooseSpeaker();
      if (this.generation !== generation) return;
      if (!decision || decision.done) {
        await this.#finish(decision?.reason || '已完成全部环节');
        return;
      }

      const before = this.runtime.turn;
      await this.#runTurn(decision.agent, decision.focus, decision.reason);
      if (this.generation !== generation) return;
      if (this.runtime.status !== 'running' && this.runtime.status !== 'paused') return;
      this.runtime.turn = before + 1;
      this.#save();
      await sleep(this.config.turnDelayMs);
    }
  }

  #waitResume() {
    return new Promise((resolve) => {
      this.runtime.resumeResolve = resolve;
    });
  }

  async #finish(reason) {
    if (this.runtime.status === 'done') return;
    this.runtime.goalDone = true;
    this.#log('info', `世界结束：${reason}`);

    const shouldSummarize =
      this.config.finalSummary &&
      reason !== '手动停止' &&
      reason !== '重置' &&
      this.messages.some((m) => m.from !== 'human');

    // 收尾产出仍在运行时完成：状态保持 running，直到交付物落笔
    if (shouldSummarize) {
      this.#emitSnapshot();
      try {
        await this.#summarize();
      } catch (err) {
        this.#log('error', `收尾产出失败：${err.message}`);
      }
    }

    this.runtime.status = 'done';
    this.runtime.reason = reason;
    this.endedAt = Date.now();
    this.#emitSnapshot();
    this.#save();
    this.emit('event', { t: 'finished', reason });
  }

  /* ------------------------------------------------------------------ 计划 */

  async #makePlan() {
    const conductor = this.conductor;
    const peers = [...this.agents.values()].map((a) => ({
      name: a.name,
      role: a.role,
      isConductor: a.isConductor,
    }));
    let plan = null;
    if (conductor && this.config.moderator === 'llm') {
      try {
        const provider = this.providers.get(conductor.providerId) || this.providers.get('mock');
        const res = await completeOnce({
          provider,
          model: conductor.model,
          maxTokens: 700,
          messages: [
            { role: 'system', content: PLAN_SYSTEM },
            {
              role: 'user',
              content: `【人类的目标】\n${this.goal}\n\n【可用成员】\n${peers
                .filter((p) => !p.isConductor)
                .map((p) => `- ${p.name}（${p.role}）`)
                .join('\n')}\n\n请给出计划 JSON。`,
            },
          ],
          mockContext: { kind: 'plan', goal: this.goal, peers, turn: 0 },
        });
        this.#addUsage(res.usage);
        plan = extractJson(res.text);
      } catch (err) {
        this.#log('warn', `计划生成失败，改用默认拆解：${err.message}`);
      }
    }
    if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) {
      plan = fallbackPlan(this.goal, this.speakers);
    }

    const rawTasks = plan.tasks.slice(0, 6);
    this.tasks = rawTasks.map((task, index) => ({
      id: index + 1,
      title: String(task.title || `环节 ${index + 1}`).slice(0, 80),
      owner: this.getAgentByName(task.owner)?.name || '',
      status: 'todo',
      why: String(task.why || '').slice(0, 160),
      note: '',
      dependsOn: [],
      artifact: null,
      completedBy: null,
      completedAt: null,
    }));

    // 依赖只允许指向更早的环节，天然无环
    this.tasks.forEach((task, index) => {
      const raw = rawTasks[index]?.after;
      const after = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
      task.dependsOn = [
        ...new Set(
          after
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n >= 1 && n < task.id),
        ),
      ];
    });

    // 没有认领人的环节，轮转分配给成员
    const speakers = this.speakers;
    this.tasks.forEach((task, index) => {
      if (!task.owner && speakers.length) task.owner = speakers[index % speakers.length].name;
    });

    const opening = String(plan.opening || '').trim();
    if (opening || this.conductor) {
      const msg = {
        id: uid('m'),
        seq: (this.seq += 1),
        from: this.conductor?.id || 'system',
        fromName: this.conductor?.name || '系统',
        fromRole: this.conductor?.role || '调度',
        fromColor: this.conductor?.color || '#F5B461',
        to: [],
        text: opening || `目标是：${short(this.goal, 120)}。已拆成 ${this.tasks.length} 个环节，开始推进。`,
        ts: Date.now(),
        turn: 0,
        kind: 'plan',
      };
      this.messages.push(msg);
      this.emit('event', { t: 'message', message: msg });
    }
    this.#log('info', `计划已就绪：${this.tasks.length} 个环节`);
    this.#emitSnapshot();
    this.emit('event', { t: 'tasks', tasks: this.tasks });
    this.#save();
  }

  /* ------------------------------------------------------------------ 依赖与交接 */

  #taskById(id) {
    return this.tasks.find((t) => t.id === Number(id)) || null;
  }

  #pendingDeps(task) {
    return (task?.dependsOn || []).filter((id) => this.#taskById(id)?.status !== 'done');
  }

  #depsDone(task) {
    return this.#pendingDeps(task).length === 0;
  }

  #isReady(task) {
    return Boolean(task) && task.status !== 'done' && this.#depsDone(task);
  }

  #readyTasks() {
    return this.tasks.filter((t) => this.#isReady(t));
  }

  #handoffText(limit = 260) {
    const rows = this.tasks
      .filter((t) => t.status === 'done' && t.artifact)
      .map((t) => `#${t.id} ${t.title} — ${t.artifact.by}：${short(t.artifact.text, limit)}`);
    return rows.join('\n') || '（还没有交接记录）';
  }

  #boardText(withDeps = true) {
    return (
      this.tasks
        .map((t) => {
          const pending = this.#pendingDeps(t);
          const flag = t.status === 'done' ? '已完成' : pending.length ? `等待 ${pending.map((d) => `#${d}`).join('、')}` : '可开始';
          return `#${t.id} [${t.status}] ${t.title} — ${t.owner || '未指派'}${
            withDeps ? `（${flag}）` : ''
          }${t.note ? ` · ${short(t.note, 40)}` : ''}`;
        })
        .join('\n') || '（暂无）'
    );
  }

  /* ------------------------------------------------------------------ 调度 */

  async #chooseSpeaker() {
    const speakers = this.speakers;
    if (!speakers.length) return { done: true, reason: '没有可发言的成员' };
    // 人类点名优先：让被点到的人立刻接手
    if (this.runtime.priorityAgentId) {
      const picked = this.agents.get(this.runtime.priorityAgentId);
      const focus = this.runtime.priorityFocus || '';
      this.runtime.priorityAgentId = null;
      this.runtime.priorityFocus = null;
      if (picked && !picked.isConductor) {
        return { agent: picked, focus, reason: '人类点名', plannedBy: 'human' };
      }
    }
    const conductor = this.conductor;
    if (!conductor || this.config.moderator === 'rules') return this.#ruleChoose();

    try {
      const provider = this.providers.get(conductor.providerId) || this.providers.get('mock');
      const res = await completeOnce({
        provider,
        model: conductor.model,
        maxTokens: 260,
        messages: [
          { role: 'system', content: CONDUCTOR_SYSTEM },
          { role: 'user', content: this.#selectionBriefing() },
        ],
        mockContext: {
          kind: 'select',
          goal: this.goal,
          peers: [...this.agents.values()].map((a) => ({
            name: a.name,
            role: a.role,
            isConductor: a.isConductor,
          })),
          tasks: this.tasks.map((t) => ({ ...t })),
          spoken: speakers.filter((a) => a.turns > 0).map((a) => a.name),
          lastSpeaker: this.agents.get(this.#lastSpeakerId())?.name || null,
          turn: this.runtime.turn,
          maxTurns: this.config.maxTurns,
        },
      });
      this.#addUsage(res.usage);
      const decision = extractJson(res.text);
      if (!decision) throw new Error('调度结果不是有效 JSON');
      const next = String(decision.next || '').trim();
      if (/^done$/i.test(next) || next === '结束') {
        return { done: true, reason: String(decision.reason || '指挥家认为可以收尾了') };
      }
      const agent = this.getAgentByName(next);
      if (!agent || agent.isConductor) throw new Error(`调度到了未知成员：${next}`);
      if (agent.turns >= 2 && this.#lastSpeakerId() === agent.id && this.#consecutiveFrom(agent.id) >= 2) {
        return this.#ruleChoose();
      }
      return {
        agent,
        focus: String(decision.focus || '').trim() || `推进「${this.#nextOpenTask()?.title || this.goal}」`,
        reason: String(decision.reason || '').trim(),
        plannedBy: 'llm',
      };
    } catch (err) {
      this.#log('warn', `调度失败，改用规则调度：${err.message}`);
      return this.#ruleChoose();
    }
  }

  #selectionBriefing() {
    const board = this.#boardText();
    const handoff = this.#handoffText(120);
    const roster = [...this.agents.values()]
      .map(
        (a) =>
          `${a.name}（${a.role}）${a.isConductor ? ' · 指挥官，不发言' : ''} · 已发言 ${a.turns} 次${
            a.lastLine ? ` · 上次：${short(a.lastLine, 50)}` : ''
          }`,
      )
      .join('\n');
    const recent = this.messages
      .slice(-8)
      .map((m) => `${m.fromName}：${short(m.text, 100)}`)
      .join('\n');
    return `【目标】${this.goal}\n\n【任务板】\n${board}\n\n【已交接的产出】\n${handoff}\n\n【成员】\n${roster}\n\n【最近发言】\n${
      recent || '（还没人说话）'
    }\n\n【当前回合】${this.runtime.turn + 1} / ${
      this.config.maxTurns
    }\n只安排前置已完成的环节；还在等前置产出的环节不要派活。请输出调度 JSON。`;
  }

  #nextOpenTask() {
    const ready = this.#readyTasks();
    return ready.find((t) => t.status === 'doing') || ready[0] || null;
  }

  #ruleChoose() {
    const speakers = this.speakers;
    const open = this.#nextOpenTask();
    if (!open) {
      return this.tasks.every((t) => t.status === 'done')
        ? { done: true, reason: '任务板已全部完成' }
        : { done: true, reason: '所有环节都在等待无法满足的前置，收尾' };
    }
    const owner = this.getAgentByName(open.owner);
    let agent = owner && !owner.isConductor ? owner : speakers[this.runtime.turn % speakers.length];
    if (speakers.length > 1 && this.#consecutiveFrom(agent.id) >= 2) {
      agent = speakers.find((a) => this.#consecutiveFrom(a.id) === 0) || agent;
    }
    return {
      agent,
      focus: `推进「${open.title}」，给出下一步具体动作`,
      reason: '规则调度',
      plannedBy: 'rules',
    };
  }

  #lastSpeakerId() {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].from !== 'human' && this.messages[i].kind !== 'plan') {
        return this.messages[i].from;
      }
    }
    return null;
  }

  #consecutiveFrom(agentId) {
    let count = 0;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m.kind === 'plan' || m.kind === 'system' || m.kind === 'final') continue;
      if (m.from === agentId) count += 1;
      else if (m.from !== 'human') break;
      else continue;
    }
    return count;
  }

  /* ------------------------------------------------------------------ 发言 */

  async #runTurn(agent, focus = '', reason = '') {
    const turn = this.runtime.turn + 1;
    this.#markOwnedTaskDoing(agent);
    agent.status = 'thinking';
    this.#emitSnapshot();
    this.emit('event', {
      t: 'turn.start',
      agentId: agent.id,
      agentName: agent.name,
      color: agent.color,
      focus,
      reason,
      turn,
    });

    let text = '';
    try {
      if (agent.kind === 'external') {
        const answer = await this.#awaitExternal(agent, focus, turn);
        if (answer == null) {
          agent.status = 'idle';
          this.#log('warn', `${agent.name} 未在时限内回应，本轮跳过`);
          this.emit('event', { t: 'turn.skip', agentId: agent.id, agentName: agent.name });
          this.#emitSnapshot();
          return;
        }
        text = answer;
      } else {
        const provider = this.providers.get(agent.providerId) || this.providers.get('mock');
        const controller = new AbortController();
        this.runtime.abort = controller;
        agent.status = 'speaking';
        this.#emitSnapshot();
        const res = await streamChat({
          provider,
          model: agent.model,
          messages: this.#buildMessages(agent, focus),
          temperature: agent.temperature,
          maxTokens: this.config.maxTokens,
          signal: controller.signal,
          onDelta: (delta) => {
            this.emit('event', { t: 'delta', agentId: agent.id, text: delta });
          },
          mockContext: this.#mockContext(agent, focus, turn),
        });
        text = (res.text || '').trim();
        this.#addUsage(res.usage);
      }
    } catch (err) {
      this.runtime.abort = null;
      if (err.name === 'AbortError') {
        agent.status = 'idle';
        this.#log('warn', `${agent.name} 的发言被中断`);
        this.#emitSnapshot();
        return;
      }
      agent.status = 'error';
      this.runtime.consecutiveErrors += 1;
      this.#log('error', `${agent.name} 发言失败：${err.message}`);
      this.emit('event', { t: 'error', agentId: agent.id, message: err.message });
      this.#emitSnapshot();
      if (this.runtime.consecutiveErrors >= 3) {
        this.runtime.status = 'paused';
        this.#log('error', '连续三次失败，已自动暂停');
      }
      return;
    } finally {
      this.runtime.abort = null;
    }

    if (!text) {
      agent.status = 'idle';
      this.#log('warn', `${agent.name} 没有产出内容`);
      this.#emitSnapshot();
      return;
    }

    this.runtime.consecutiveErrors = 0;
    this.#commitMessage(agent, text, turn);
  }

  #buildMessages(agent, focus) {
    const board = this.#boardText();
    const handoff = this.#handoffText(200);
    const waiting = this.tasks
      .filter((t) => t.owner === agent.name && t.status !== 'done' && this.#pendingDeps(t).length)
      .map(
        (t) =>
          `#${t.id} ${t.title} 还在等 ${this.#pendingDeps(t)
            .map((d) => `#${d}`)
            .join('、')} 的产出`,
      );
    const memory =
      this.memory
        .slice(-10)
        .map((m) => `- ${m.text}`)
        .join('\n') || '（暂无）';
    const recent =
      this.messages
        .slice(-12)
        .map((m) => {
          const target = m.to?.length ? ` → ${m.to.map((x) => `@${x}`).join(' ')}` : '';
          return `${m.fromName}${target}：${short(m.text, 240)}`;
        })
        .join('\n') || '（还没有人发言）';
    const inbox = agent.inbox.length
      ? agent.inbox.map((m) => `- ${m.fromName}：${short(m.text, 200)}`).join('\n')
      : '（空）';
    const others = [...this.agents.values()]
      .filter((a) => a.id !== agent.id)
      .map((a) => `${a.name}（${a.role}）`)
      .join('、');

    const user = [
      `【世界目标】\n${this.goal}`,
      `【任务板】\n${board}`,
      `【交接与产出】\n${handoff}`,
      waiting.length
        ? `【你正在等待】\n${waiting.join('\n')}\n在这些前置产出进入交接区之前，不要开始或宣告完成对应环节；如被问到，直接说明你在等什么。`
        : '',
      `【长期记忆】\n${memory}`,
      `【其他成员】\n${others || '（无）'}`,
      `【最近对话】\n${recent}`,
      `【你的私信】\n${inbox}`,
      `【现在轮到你发言】${focus ? `\n本轮聚焦：${focus}` : ''}\n请直接给出你的实质贡献（≤160 字），需要谁接力就 @他。`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const system = agent.system ? `${agent.system}\n\n${PROTOCOL}` : agentSystemPrompt(agent);
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  #mockContext(agent, focus, turn) {
    return {
      kind: 'agent',
      name: agent.name,
      roleKey: agent.personaKey,
      role: agent.role,
      focus,
      goal: this.goal,
      tasks: this.tasks.map((t) => ({ ...t })),
      peers: [...this.agents.values()].map((a) => ({
        name: a.name,
        role: a.role,
        isConductor: a.isConductor,
      })),
      recent: this.messages.slice(-4).map((m) => ({ fromName: m.fromName, text: m.text })),
      ownedTasks: this.tasks.filter((t) => t.owner === agent.name).map((t) => ({ ...t })),
      turn,
    };
  }

  #markOwnedTaskDoing(agent) {
    const task = this.tasks.find(
      (t) => t.owner === agent.name && t.status === 'todo' && this.#depsDone(t),
    );
    if (!task) return;
    task.status = 'doing';
    this.emit('event', { t: 'tasks', tasks: this.tasks });
  }

  #commitMessage(agent, raw, turn) {
    const parsed = parseMarkers(raw);
    const text = parsed.text;
    if (!text) return;
    const conflicts = [];

    const names = [...this.agents.values()]
      .map((a) => a.name)
      .sort((a, b) => b.length - a.length);
    const mentions = [];
    for (const name of names) {
      if (name === agent.name) continue;
      const re = new RegExp(`@${escapeRegExp(name)}(?![\\w\\u4e00-\\u9fa5])`, 'u');
      if (re.test(text)) mentions.push(name);
    }

    const message = {
      id: uid('m'),
      seq: (this.seq += 1),
      from: agent.id,
      fromName: agent.name,
      fromRole: agent.role,
      fromColor: agent.color,
      to: mentions,
      text,
      ts: Date.now(),
      turn,
      kind: mentions.length ? 'direct' : 'broadcast',
      markers: {
        tasks: parsed.tasks,
        memories: parsed.memories.length,
        conflicts: conflicts.length,
      },
    };
    this.messages.push(message);

    for (const name of mentions) {
      const target = this.getAgentByName(name);
      if (target) target.inbox.push({ fromName: agent.name, text: short(text, 300), ts: Date.now() });
    }

    for (const marker of parsed.tasks) {
      const task = this.#taskById(marker.id);
      if (!task) {
        conflicts.push(`#${marker.id} 不存在`);
        continue;
      }

      if (marker.status === 'blocked') {
        if (task.owner && task.owner !== agent.name) {
          conflicts.push(`#${task.id} 由 ${task.owner} 负责，不能代报阻塞`);
          continue;
        }
        task.status = 'blocked';
        task.note = marker.note || '';
        continue;
      }

      // 完成声明：只认负责人；前置未交付则挂起
      if (task.status === 'done') continue;
      if (task.owner && task.owner !== agent.name && !agent.isConductor) {
        conflicts.push(`#${task.id} 由 ${task.owner} 负责，${agent.name} 不能代为完成`);
        task.note = `交接冲突：${agent.name} 试图代完成`;
        continue;
      }
      const pending = this.#pendingDeps(task);
      if (pending.length) {
        conflicts.push(`#${task.id} 还在等 ${pending.map((d) => `#${d}`).join('、')} 的产出`);
        task.note = `等待 ${pending.map((d) => `#${d}`).join('、')} 的产出`;
        if (task.status === 'todo') task.status = 'doing';
        continue;
      }

      task.status = 'done';
      task.completedBy = agent.name;
      task.completedAt = Date.now();
      task.note = '';
      task.artifact = { by: agent.name, text: short(text, 800), ts: Date.now() };

      // 把产出交接给依赖它的成员
      for (const dep of this.tasks) {
        if (!dep.dependsOn?.includes(task.id) || dep.status === 'done') continue;
        const owner = this.getAgentByName(dep.owner);
        if (owner) {
          owner.inbox.push({
            fromName: '交接',
            text: `#${task.id}「${task.title}」已完成，产出：${short(text, 220)}。你可以开始 #${dep.id}「${dep.title}」。`,
            ts: Date.now(),
          });
        }
      }
      this.#log('info', `#${task.id} 已由 ${agent.name} 交付：${short(text, 60)}`);
    }
    if (conflicts.length) {
      this.#log('warn', `交接冲突被拦下：${conflicts.join('；')}`);
      this.emit('event', { t: 'conflict', conflicts, agentId: agent.id, agentName: agent.name });
    }
    for (const body of parsed.memories) {
      this.memory.push({ id: uid('mem_'), text: body.slice(0, 300), by: agent.name, ts: Date.now() });
    }
    if (this.memory.length > 80) this.memory.splice(0, this.memory.length - 80);

    if (parsed.goalDone) this.runtime.goalDone = true;
    if (this.tasks.length && this.tasks.every((t) => t.status === 'done')) {
      this.#log('info', '任务板已全部完成');
    }

    agent.status = 'idle';
    agent.turns += 1;
    agent.chars += text.length;
    agent.lastLine = short(text, 120);
    agent.lastTurnAt = Date.now();
    agent.inbox = [];

    this.emit('event', { t: 'message', message });
    this.emit('event', { t: 'tasks', tasks: this.tasks });
    if (parsed.memories.length) this.emit('event', { t: 'memory', memory: this.memory });
    this.emit('event', {
      t: 'turn.end',
      agentId: agent.id,
      agentName: agent.name,
      turn,
      chars: text.length,
    });
    this.#emitSnapshot();
    this.#save();
  }

  /* ------------------------------------------------------------------ 外部成员 */

  #awaitExternal(agent, focus, turn) {
    return new Promise((resolve) => {
      const timeout = Math.max(1000, this.config.externalTimeoutMs);
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.runtime.awaiting?.agentId === agent.id) this.runtime.awaiting = null;
        this.#emitSnapshot();
        resolve(value);
      };
      const timer = setTimeout(() => settle(null), timeout);
      if (timer.unref) timer.unref();
      this.runtime.awaiting = {
        agentId: agent.id,
        agentName: agent.name,
        focus,
        turn,
        timeout,
        resolve: (text) => settle(text),
        cancel: () => settle(null),
      };
      agent.status = 'awaiting';
      this.#emitSnapshot();
      this.emit('event', {
        t: 'awaiting',
        agentId: agent.id,
        agentName: agent.name,
        focus,
        timeoutMs: timeout,
        turn,
      });
    });
  }

  /** 外部程序以成员身份说话（HTTP 桥 / CLI 都走这里） */
  sayAsAgent(name, text, toName) {
    const agent = this.getAgentByName(name);
    if (!agent) throw new Error(`没有名为 ${name} 的成员`);
    const body = String(text || '').trim();
    if (!body) throw new Error('内容为空');

    const awaiting = this.runtime.awaiting;
    if (awaiting && awaiting.agentId === agent.id) {
      awaiting.resolve(body);
      return { delivered: true, mode: 'turn' };
    }
    this.#commitMessage(agent, body, this.runtime.turn);
    return { delivered: true, mode: 'spontaneous' };
  }

  /* ------------------------------------------------------------------ 人类 */

  speakAsHuman(text, toName) {
    const body = String(text || '').trim();
    if (!body) throw new Error('内容为空');

    const names = [...this.agents.values()]
      .map((a) => a.name)
      .sort((a, b) => b.length - a.length);
    const mentions = [];
    for (const name of names) {
      const re = new RegExp(`@${escapeRegExp(name)}(?![\\w\\u4e00-\\u9fa5])`, 'u');
      if (re.test(body)) mentions.push(name);
    }
    const target = toName ? this.getAgentByName(toName) : null;
    const recipients = target ? [target.name] : mentions;

    const message = {
      id: uid('m'),
      seq: (this.seq += 1),
      from: 'human',
      fromName: '人类',
      fromRole: '指令',
      fromColor: '#F2EAD8',
      to: recipients,
      text: body,
      ts: Date.now(),
      turn: this.runtime.turn,
      kind: recipients.length ? 'direct' : 'broadcast',
    };
    this.messages.push(message);
    for (const name of recipients) {
      const agent = this.getAgentByName(name);
      if (agent) agent.inbox.push({ fromName: '人类', text: short(body, 400), ts: Date.now() });
    }
    if (recipients.length) {
      const target = this.getAgentByName(recipients[0]);
      if (target && !target.isConductor) {
        this.runtime.priorityAgentId = target.id;
        this.runtime.priorityFocus = `人类刚刚对你说：${short(body, 140)}`;
      }
    }

    const awaiting = this.runtime.awaiting;
    if (awaiting && recipients.includes(awaiting.agentName)) {
      awaiting.resolve(body);
    }

    this.emit('event', { t: 'message', message });
    this.#emitSnapshot();
    this.#save();

    // 静静待命时被点名：让它单独回应一句
    if (target && !target.isConductor && this.runtime.status !== 'running' && this.runtime.status !== 'paused') {
      this.#runSingleTurn(target, body).catch((err) => {
        this.#log('error', `单轮回应失败：${err.message}`);
        this.#emitSnapshot();
      });
    }
    return message;
  }

  async #runSingleTurn(agent, focus) {
    this.runtime.status = 'running';
    this.#emitSnapshot();
    await this.#runTurn(agent, `人类直接对你说：${short(focus, 120)}`);
    this.runtime.turn += 1;
    this.runtime.status = 'idle';
    this.#emitSnapshot();
    this.#save();
  }

  setTaskStatus(id, status) {
    const task = this.tasks.find((t) => t.id === Number(id));
    if (!task) throw new Error('任务不存在');
    if (!['todo', 'doing', 'done', 'blocked'].includes(status)) throw new Error('非法状态');
    task.status = status;
    this.emit('event', { t: 'tasks', tasks: this.tasks });
    this.#log('info', `人类把任务 #${task.id} 标记为 ${status}`);
    this.#emitSnapshot();
    this.#save();
  }

  /* ------------------------------------------------------------------ 收尾产出 */

  async #summarize() {
    const agent =
      this.speakers.find((a) => a.personaKey === 'weaver') ||
      this.speakers.find((a) => a.role === '织网者') ||
      this.speakers[0];
    if (!agent) return;
    const turn = this.runtime.turn + 1;
    agent.status = 'speaking';
    this.#emitSnapshot();
    const transcript = this.messages
      .slice(-30)
      .map((m) => `${m.fromName}：${short(m.text, 260)}`)
      .join('\n');
    const board = this.#boardText(false);
    const handoff = this.#handoffText(300);
    const system = `${
      agent.system || agentSystemPrompt(agent)
    }\n\n现在是收尾阶段：人类需要的是一份可以直接使用的最终交付物，而不是讨论过程。`;
    const user = `【目标】\n${this.goal}\n\n【任务板】\n${board}\n\n【交接与产出】\n${handoff}\n\n【对话摘录】\n${transcript}\n\n请输出最终交付物：以各环节的交接产出为基础，用简洁的 Markdown 组织（可含小标题、步骤、结论、待办）。不要寒暄，不要复述讨论过程，直接给结果。`;
    try {
      const res = await streamChat({
        provider: this.providers.get(agent.providerId) || this.providers.get('mock'),
        model: agent.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.6,
        maxTokens: 1600,
        onDelta: (delta) => this.emit('event', { t: 'delta', agentId: agent.id, text: delta }),
        mockContext: {
          kind: 'final',
          name: agent.name,
          roleKey: 'weaver',
          role: agent.role,
          focus: '收尾：输出最终交付物',
          goal: this.goal,
          tasks: this.tasks,
          peers: [...this.agents.values()].map((a) => ({ name: a.name, role: a.role })),
          recent: this.messages.slice(-4).map((m) => ({ fromName: m.fromName, text: m.text })),
          ownedTasks: [],
          turn,
        },
      });
      this.#addUsage(res.usage);
      const text = res.text.trim();
      if (!text) return;
      const message = {
        id: uid('m'),
        seq: (this.seq += 1),
        from: agent.id,
        fromName: agent.name,
        fromRole: agent.role,
        fromColor: agent.color,
        to: [],
        text,
        ts: Date.now(),
        turn,
        kind: 'final',
      };
      this.messages.push(message);
      this.summary = text;
      agent.lastLine = short(text.replace(/[#>*`-]/g, ''), 110);
      this.emit('event', { t: 'message', message });
      this.#log('info', `${agent.name} 产出了最终交付物`);
    } finally {
      agent.status = 'idle';
      this.#emitSnapshot();
    }
  }

  /* ------------------------------------------------------------------ 工具 */

  #addUsage(usage) {
    if (!usage) return;
    this.usage.prompt += usage.prompt || 0;
    this.usage.completion += usage.completion || 0;
    this.usage.calls += 1;
  }

  #log(level, text) {
    const entry = { ts: Date.now(), level, text, turn: this.runtime.turn };
    this.logs.push(entry);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.emit('event', { t: 'log', entry });
  }

  #emitSnapshot() {
    this.emit('snapshot', this.snapshot());
  }

  #save() {
    this.store?.save?.(this.toJSON());
  }

  snapshot() {
    return {
      id: this.id,
      title: this.title,
      goal: this.goal,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      status: this.runtime.status,
      reason: this.runtime.reason,
      error: this.runtime.error,
      turn: this.runtime.turn,
      config: this.config,
      usage: this.usage,
      summary: this.summary,
      agents: [...this.agents.values()].map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        glyph: a.glyph,
        color: a.color,
        personaKey: a.personaKey,
        isConductor: a.isConductor,
        kind: a.kind,
        providerId: a.providerId,
        model: a.model,
        temperature: a.temperature,
        status: a.status,
        turns: a.turns,
        chars: a.chars,
        lastLine: a.lastLine,
        lastTurnAt: a.lastTurnAt,
        unread: a.inbox.length,
      })),
      awaiting: this.runtime.awaiting
        ? {
            agentId: this.runtime.awaiting.agentId,
            agentName: this.runtime.awaiting.agentName,
            focus: this.runtime.awaiting.focus,
            timeout: this.runtime.awaiting.timeout,
          }
        : null,
      messages: this.messages.slice(-400),
      tasks: this.tasks,
      memory: this.memory.slice(-60),
      logs: this.logs.slice(-160),
    };
  }

  toJSON() {
    const snap = this.snapshot();
    return {
      version: 1,
      ...snap,
      config: this.config,
      seq: this.seq,
    };
  }

  static fromJSON(data, { providers, store } = {}) {
    const world = new World({
      title: data.title,
      goal: data.goal,
      providers,
      store,
      config: data.config,
    });
    world.id = data.id || world.id;
    world.createdAt = data.createdAt || Date.now();
    world.startedAt = data.startedAt || null;
    world.endedAt = data.endedAt || null;
    world.messages = Array.isArray(data.messages) ? data.messages : [];
    world.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    world.memory = Array.isArray(data.memory) ? data.memory : [];
    world.logs = Array.isArray(data.logs) ? data.logs : [];
    world.summary = data.summary || null;
    world.seq = data.seq || world.messages.length;
    world.usage = data.usage || { prompt: 0, completion: 0, calls: 0 };
    world.runtime.turn = data.turn || 0;
    world.runtime.status = data.status === 'running' ? 'paused' : data.status || 'idle';
    world.runtime.reason = data.reason || null;
    for (const a of data.agents || []) {
      world.agents.set(a.id, {
        ...a,
        status: 'idle',
        inbox: [],
      });
    }
    if (world.runtime.status === 'paused') {
      world.runtime.status = 'idle';
    }
    return world;
  }

  exportMarkdown() {
    const lines = [`# ${this.title}`, '', `> **目标**：${this.goal}`, ''];
    if (this.startedAt) {
      lines.push(`> 开始：${new Date(this.startedAt).toLocaleString('zh-CN')}`);
    }
    if (this.runtime.reason) lines.push(`> 结束原因：${this.runtime.reason}`);
    lines.push(`> 参与智能体：${[...this.agents.values()].map((a) => `${a.name}（${a.role}）`).join('、')}`, '');
    lines.push('## 任务板', '');
    for (const t of this.tasks) {
      const mark = t.status === 'done' ? 'x' : ' ';
      const deps = t.dependsOn?.length ? `（前置 ${t.dependsOn.map((d) => `#${d}`).join('、')}）` : '';
      lines.push(`- [${mark}] #${t.id} ${t.title}${t.owner ? ` — ${t.owner}` : ''}${deps}`);
      if (t.artifact) {
        lines.push(`  > 交接：${t.artifact.by} — ${t.artifact.text.replace(/\n/g, ' ')}`);
      }
    }
    lines.push('', '## 长期记忆', '');
    if (!this.memory.length) lines.push('_（无）_');
    for (const m of this.memory) lines.push(`- ${m.text}  \n  <sub>${m.by}</sub>`);
    lines.push('', '## 对话实录', '');
    for (const m of this.messages) {
      const target = m.to?.length ? ` → ${m.to.map((x) => `@${x}`).join(' ')}` : '';
      lines.push(`### ${m.fromName}${m.fromRole ? `（${m.fromRole}）` : ''}${target}`, '', m.text, '');
    }
    if (this.summary) {
      lines.push('## 最终交付物', '', this.summary, '');
    }
    return lines.join('\n');
  }
}

/** 计划生成失败时的兜底拆解 */
export function fallbackPlan(goal, speakers) {
  const titles = ['澄清目标与验收标准', '提出可行路径', '压力测试与风险审查', '整合产出并交付'];
  const names = (speakers || []).map((s) => s.name || s);
  return {
    tasks: titles.map((title, i) => ({
      title,
      owner: names.length ? names[i % names.length] : '',
      why: '',
    })),
    opening: `目标是：${short(goal, 80)}。我把它拆成 ${titles.length} 个环节，按顺序推进。`,
  };
}

export function createDefaultWorld({ title, goal, providers, store, config }) {
  const world = new World({ title, goal, providers, store, config });
  for (const key of DEFAULT_ROSTER) {
    const persona = PERSONAS.find((p) => p.key === key);
    if (!persona) continue;
    world.addAgent({
      name: persona.name,
      role: persona.role,
      glyph: persona.glyph,
      color: persona.color,
      personaKey: persona.key,
      isConductor: persona.isConductor,
      providerId: 'mock',
      model: 'confluence-mock',
    });
  }
  return world;
}

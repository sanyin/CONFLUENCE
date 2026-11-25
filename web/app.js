/* ==========================================================================
   汇流 · CONFLUENCE — 客户端
   无框架、无构建步骤。世界状态由服务端快照驱动，发言流由增量事件驱动。
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const state = {
  world: null,
  providers: [],
  personas: [],
  defaults: { roster: [] },
  activeTab: 'live',
  selectedAgentId: null,
  genesisMembers: [],
  genesisModelMode: 'auto',
  genesisModeInited: false,
  genesisProvider: 'mock',
  live: null, // { agentId, text }
  streaming: new Map(),
  bubbleTimers: new Map(),
  nodes: new Map(),
  pan: { x: 0, y: 0 },
  zoom: 1,
  feedSig: '',
  feedInited: false,
  editingAgentId: null,
  ws: null,
  wsReady: false,
  lastEventAt: 0,
  watchdog: null,
  pingTimer: null,
};

/* ── 工具 ─────────────────────────────────────────────────────────────── */

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeOf(ts) {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function agentById(id) {
  return state.world?.agents.find((a) => a.id === id) || null;
}

function agentByName(name) {
  return state.world?.agents.find((a) => a.name.toLowerCase() === String(name).toLowerCase()) || null;
}

let toastTimer = null;
function toast(message, type = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.type = type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, type === 'error' ? 6000 : 4200);
}

function statusLabel(status) {
  return (
    {
      idle: '待命',
      running: '运行中',
      paused: '已暂停',
      done: '已结束',
      error: '出错了',
    }[status] || status
  );
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */

async function boot() {
  bindStatic();
  initRosterPicks();
  try {
    const data = await api('/api/state');
    state.providers = data.providers || [];
    state.personas = data.personas || [];
    state.defaults = data.defaults || { roster: [] };
    syncGenesisProviders();
    if (data.world) {
      applySnapshot(data.world);
      hideGenesis();
    } else {
      showGenesis();
    }
  } catch (err) {
    toast(`无法连接到本地服务：${err.message}`, 'error');
    showGenesis();
  }
  connectWS();
  startPacketLoop();
  state.pingTimer = setInterval(refreshPing, 8000);
  refreshPing();
}

/* ── WebSocket ────────────────────────────────────────────────────────── */

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.wsReady = true;
    state.lastEventAt = Date.now();
    ws.send(JSON.stringify({ type: 'sync' }));
    setTimeout(refreshPing, 300);
  });

  ws.addEventListener('message', (evt) => {
    state.lastEventAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      if (msg.world) {
        applySnapshot(msg.world);
        hideGenesis();
      } else {
        state.world = null;
        renderAll();
        showGenesis();
      }
    } else if (msg.type === 'event') {
      handleEvent(msg.event);
    } else if (msg.type === 'providers') {
      state.providers = msg.providers || [];
      renderProviderList();
    } else if (msg.type === 'error') {
      toast(msg.message, 'error');
    }
  });

  ws.addEventListener('close', () => {
    state.wsReady = false;
    if (state.world) $('#statusSub').textContent = '与本地服务断开，正在重连…';
    setTimeout(connectWS, 1500);
  });

  // 守夜：若长时间收不到任何消息，主动重连，避免半开连接导致画面冻结
  clearInterval(state.watchdog);
  state.watchdog = setInterval(() => {
    if (!state.wsReady) return;
    if (Date.now() - state.lastEventAt > 45000) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  }, 15000);
}

async function refreshPing() {
  try {
    const res = await fetch('/api/ping');
    const data = await res.json();
    $('#clientText').textContent = String(data.clients ?? 0);
  } catch {
    /* noop */
  }
}

/* ── 快照与事件 ───────────────────────────────────────────────────────── */

function applySnapshot(world) {
  const isNew = !state.world || state.world.id !== world.id;
  state.world = world;
  if (isNew) {
    state.nodes.forEach((n) => n.el.remove());
    state.nodes.clear();
    state.pan = { x: 0, y: 0 };
    state.zoom = 1;
    state.selectedAgentId = null;
    applyTransform();
    $('#feed').innerHTML = '';
    state.feedSig = '';
    state.feedInited = false;
  }
  renderAll();
}

function handleEvent(ev) {
  if (!ev) return;
  switch (ev.t) {
    case 'turn.start': {
      // 同一时刻只保留一个气泡，避免画面被历史发言堆满
      for (const [id, node] of state.nodes) {
        node.el.classList.remove('has-bubble');
        const timer = state.bubbleTimers.get(id);
        if (timer) clearTimeout(timer);
        state.bubbleTimers.delete(id);
      }
      state.live = { agentId: ev.agentId, text: '' };
      state.streaming.set(ev.agentId, '');
      renderNodes();
      renderFeed();
      setTyping(ev.agentId, ev.focus);
      break;
    }
    case 'delta': {
      state.streaming.set(ev.agentId, (state.streaming.get(ev.agentId) || '') + ev.text);
      if (state.live && state.live.agentId === ev.agentId) {
        state.live.text += ev.text;
        const liveText = $('#liveText');
        if (liveText) liveText.textContent = state.live.text;
        maybeAutoScroll();
      }
      const node = state.nodes.get(ev.agentId);
      if (node) {
        const bubble = $('.node-bubble', node.el);
        if (bubble) bubble.textContent = state.streaming.get(ev.agentId) || '';
      }
      break;
    }
    case 'turn.end': {
      state.streaming.delete(ev.agentId);
      state.live = null;
      const node = state.nodes.get(ev.agentId);
      if (node) {
        // 保留气泡；文本会在下一次快照中替换为剔除协议标记后的版本
        node.el.classList.add('has-bubble');
        const timer = state.bubbleTimers.get(ev.agentId);
        if (timer) clearTimeout(timer);
        state.bubbleTimers.set(
          ev.agentId,
          setTimeout(() => {
            node.el.classList.remove('has-bubble');
            state.bubbleTimers.delete(ev.agentId);
          }, 5200),
        );
      }
      setTyping(null);
      break;
    }
    case 'turn.skip':
    case 'awaiting': {
      if (ev.t === 'awaiting') {
        toast(`${ev.agentName} 正在等待外部程序投递内容（${Math.round(ev.timeoutMs / 1000)}s）`);
      }
      break;
    }
    case 'message': {
      const m = ev.message;
      if (m && m.from !== 'human') {
        spawnPacketsForMessage(m);
      }
      break;
    }
    case 'tasks':
    case 'memory':
      break;
    case 'conflict':
      toast(`交接冲突：${(ev.conflicts || []).join('；')}`, 'error');
      break;
    case 'error':
      toast(`${ev.message}`, 'error');
      break;
    case 'finished':
      toast(`世界结束：${ev.reason}`);
      break;
    default:
      break;
  }
}

/* ── 渲染总入口 ───────────────────────────────────────────────────────── */

function renderAll() {
  renderHeader();
  renderRoster();
  renderCore();
  renderNodes();
  renderFeed();
  renderTasks();
  renderMemory();
  renderLogs();
  renderControls();
  renderAwaiting();
  renderModelLine();
  renderConfigInputs();
}

function renderHeader() {
  const w = state.world;
  const status = w?.status || 'idle';
  const pill = $('#statusPill');
  pill.dataset.state = status;
  $('#statusText').textContent = statusLabel(status);
  $('#turnText').textContent = String(w?.turn ?? 0).padStart(2, '0');
  const usage = w?.usage || { prompt: 0, completion: 0 };
  $('#usageText').textContent = `tokens ${usage.prompt + usage.completion}`;
  $('#worldTitle').textContent = w?.title || '尚未创建世界';
  $('#worldGoal').textContent = w?.goal || '写下你想让它们共同完成的事，然后点亮议会。';
  const maxTurns = w?.config?.maxTurns || 24;
  const turn = w?.turn || 0;
  $('#progressText').textContent = `${turn} / ${maxTurns}`;
  $('#progressBar').style.width = `${clamp((turn / maxTurns) * 100, 0, 100)}%`;
  const statusSub = $('#statusSub');
  statusSub.textContent = w?.reason
    ? w.reason
    : w
      ? status === 'running'
        ? '正在协作…'
        : status === 'paused'
          ? '已暂停，等待你继续'
          : '等待指令'
      : '等待任务';
  statusSub.title = w?.reason || '';
}

function renderModelLine() {
  const w = state.world;
  if (!w) {
    $('#modelLine').textContent = '—';
    return;
  }
  const counts = new Map();
  for (const a of w.agents) {
    const provider = state.providers.find((p) => p.id === a.providerId);
    const key = `${provider?.name || a.providerId} · ${a.model}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  $('#modelLine').textContent = [...counts.entries()]
    .map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`)
    .join('\n');
}

function renderControls() {
  const status = state.world?.status || 'idle';
  const running = status === 'running';
  const paused = status === 'paused';
  const btnRun = $('#btnRun');
  btnRun.disabled = running;
  btnRun.textContent = paused ? '继续' : status === 'done' ? '重新开始' : '开始';
  btnRun.classList.toggle('primary', !running);
  const btnPause = $('#btnPause');
  btnPause.disabled = !running;
  btnPause.classList.toggle('primary', running);
  btnPause.textContent = running ? '暂停' : '暂停';
  $('#btnStop').disabled = !running && !paused;
}

/* ── 成员 ─────────────────────────────────────────────────────────────── */

function renderRoster() {
  const roster = $('#roster');
  const agents = state.world?.agents || [];
  if (!agents.length) {
    roster.innerHTML = '<div class="panel-empty">还没有成员</div>';
    return;
  }
  roster.innerHTML = agents
    .map((a) => {
      const selected = state.selectedAgentId === a.id;
      return `<button class="member${selected ? ' is-selected' : ''}" data-id="${a.id}" data-status="${a.status}" style="--c:${a.color}">
        <span class="member-orb">${escapeHtml(a.glyph)}</span>
        <span class="member-main">
          <b>${escapeHtml(a.name)}${a.isConductor ? ' <span class="micro" style="color:var(--amber)">CMD</span>' : ''}</b>
          <i>${escapeHtml(a.role)} · ${escapeHtml(a.model)}${a.kind === 'external' ? ' · 外部' : ''}</i>
        </span>
        <span class="member-state">${a.status === 'speaking' ? '说话' : a.status === 'thinking' ? '思考' : a.status === 'awaiting' ? '等待' : a.turns ? `T${a.turns}` : '—'}</span>
      </button>`;
    })
    .join('');
}

function renderAwaiting() {
  const note = $('#awaitingNote');
  const awaiting = state.world?.awaiting;
  if (!awaiting) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  $('#awaitingText').textContent = `${awaiting.agentName} 正在等待外部程序投递内容（${Math.round(
    awaiting.timeout / 1000,
  )}s）。可用 POST /api/say 或 npm run say 接入。`;
}

/* ── 舞台：核心与节点 ─────────────────────────────────────────────────── */

function renderCore() {
  const core = $('#core');
  const w = state.world;
  const status = w?.status || 'idle';
  core.classList.toggle('is-running', status === 'running');
  $('#coreGoal').textContent = w?.goal || '等待目标';
  $('#coreStatus').textContent =
    status === 'running' ? 'SIGNAL LIVE' : status === 'paused' ? 'PAUSED' : status === 'done' ? 'SEALED' : 'IDLE';
}

function orderAgents(agents) {
  return [...agents].sort((a, b) => Number(b.isConductor) - Number(a.isConductor));
}

function renderNodes() {
  const container = $('#nodes');
  const agents = orderAgents(state.world?.agents || []);
  const ids = new Set(agents.map((a) => a.id));

  for (const [id, node] of state.nodes) {
    if (!ids.has(id)) {
      node.el.remove();
      state.nodes.delete(id);
    }
  }

  agents.forEach((a) => {
    let node = state.nodes.get(a.id);
    if (!node) {
      const el = document.createElement('div');
      el.className = 'node';
      el.dataset.id = a.id;
      el.innerHTML = `
        <div class="node-orb"><span class="node-glyph"></span><span class="node-badge"></span></div>
        <div class="node-name"></div>
        <div class="node-role"></div>
        <div class="node-bar"></div>
        <div class="node-bubble"></div>`;
      container.append(el);
      node = { el, baseX: 0, baseY: 0, offX: 0, offY: 0 };
      state.nodes.set(a.id, node);
      bindNodeDrag(node, a.id);
    }
    updateNode(node, a);
  });

  layoutNodes();
  drawEdges();
}

function updateNode(node, a) {
  const el = node.el;
  el.style.setProperty('--c', a.color);
  el.classList.toggle('is-conductor', Boolean(a.isConductor));
  el.classList.toggle('is-speaking', a.status === 'speaking');
  el.classList.toggle('is-thinking', a.status === 'thinking');
  $('.node-glyph', el).textContent = a.glyph || '·';
  $('.node-name', el).textContent = a.name;
  $('.node-role', el).textContent = a.role || '';
  $('.node-badge', el).textContent =
    a.status === 'awaiting' ? 'WAIT' : a.status === 'error' ? 'ERR' : a.turns ? `T${a.turns}` : '';
  el.dataset.status = a.status;

  const bubble = $('.node-bubble', el);
  const streamed = state.streaming.get(a.id);
  if (a.status === 'speaking' || a.status === 'thinking') {
    bubble.textContent = streamed ?? (a.status === 'thinking' ? '…' : '');
  } else {
    // 快照里的 lastLine 已剔除协议标记，用它覆盖流式原文
    bubble.textContent = a.lastLine || bubble.textContent || '';
  }
}

function layoutNodes() {
  const stage = $('#stage');
  const rect = stage.getBoundingClientRect();
  const agents = orderAgents(state.world?.agents || []);
  const n = agents.length;
  if (!n) return;
  const radius = clamp(Math.min(rect.width * 0.32, rect.height * 0.37), 186, 340);
  agents.forEach((a, i) => {
    const node = state.nodes.get(a.id);
    if (!node) return;
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / n;
    node.baseX = Math.cos(angle) * radius;
    node.baseY = Math.sin(angle) * radius * 0.84;
    applyNodePos(node);
  });
}

function applyNodePos(node) {
  const x = node.baseX + node.offX;
  const y = node.baseY + node.offY;
  node.el.style.setProperty('--x', `${x.toFixed(1)}px`);
  node.el.style.setProperty('--y', `${y.toFixed(1)}px`);
  // 上半部分的节点气泡朝上，下半部分朝下：始终背离世界核心
  node.el.classList.toggle('is-upper', y < 0);
}

function nodePos(id) {
  const node = state.nodes.get(id);
  if (!node) return null;
  return { x: node.baseX + node.offX, y: node.baseY + node.offY };
}

/* ── 舞台：连线与数据包 ───────────────────────────────────────────────── */

function drawEdges() {
  const layer = $('#edgeLayer');
  if (!layer) return;
  let html = '';

  for (const [id, node] of state.nodes) {
    const p = nodePos(id);
    if (!p) continue;
    const dist = Math.hypot(p.x, p.y) || 1;
    const ux = p.x / dist;
    const uy = p.y / dist;
    html += `<line class="edge-base" x1="${(ux * 112).toFixed(1)}" y1="${(uy * 112).toFixed(1)}" x2="${(
      p.x - ux * 42
    ).toFixed(1)}" y2="${(p.y - uy * 42).toFixed(1)}" />`;
  }

  const msgs = (state.world?.messages || []).slice(-8);
  msgs.forEach((m, i) => {
    const color = m.fromColor || '#F5B461';
    const opacity = (0.1 + (i / Math.max(1, msgs.length)) * 0.32).toFixed(2);
    if (m.from === 'human') return;
    const from = nodePos(m.from);
    if (!from) return;
    if (m.kind === 'direct' && m.to?.length) {
      for (const name of m.to) {
        const target = agentByName(name);
        const to = target && nodePos(target.id);
        if (!to) continue;
        html += `<path class="edge-live" d="${edgePath(from, to, 0.24)}" stroke="${color}" stroke-width="1.1" opacity="${opacity}" />`;
      }
    } else {
      html += `<line class="edge-live" x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(
        1,
      )}" x2="${(from.x * 0.3).toFixed(1)}" y2="${(from.y * 0.3).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="${opacity}" />`;
    }
  });

  layer.innerHTML = html;
}

function edgePath(a, b, bend = 0.2) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx = mx - (b.y - a.y) * bend;
  const cy = my + (b.x - a.x) * bend;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

function quadPoint(a, c, b, t) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

const packets = [];

function spawnPacket(from, to, color, delay = 0, bend = 0.22) {
  const layer = $('#packetLayer');
  if (!layer) return;
  const cx = (from.x + to.x) / 2 - (to.y - from.y) * bend;
  const cy = (from.y + to.y) / 2 + (to.x - from.x) * bend;
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  el.setAttribute('r', '2.6');
  el.setAttribute('fill', color);
  el.setAttribute('cx', from.x);
  el.setAttribute('cy', from.y);
  el.style.filter = `drop-shadow(0 0 5px ${color})`;
  layer.append(el);
  packets.push({ el, from, to, c: { x: cx, y: cy }, start: performance.now() + delay, dur: 950 });
}

function spawnPacketsForMessage(m) {
  const from = nodePos(m.from);
  if (!from) return;
  const center = { x: 0, y: 0 };
  if (m.kind === 'direct' && m.to?.length) {
    m.to.forEach((name, idx) => {
      const target = agentByName(name);
      const to = target && nodePos(target.id);
      if (!to) return;
      spawnPacket(from, to, m.fromColor || '#F5B461', idx * 90);
    });
  } else {
    spawnPacket(from, center, m.fromColor || '#F5B461', 0, 0.08);
    spawnPacket(from, center, m.fromColor || '#F5B461', 140, -0.12);
  }
}

function startPacketLoop() {
  const tick = (now) => {
    for (let i = packets.length - 1; i >= 0; i -= 1) {
      const p = packets[i];
      if (now < p.start) continue;
      const t = (now - p.start) / p.dur;
      if (t >= 1) {
        p.el.remove();
        packets.splice(i, 1);
        continue;
      }
      const pt = quadPoint(p.from, p.c, p.to, t);
      p.el.setAttribute('cx', pt.x.toFixed(1));
      p.el.setAttribute('cy', pt.y.toFixed(1));
      p.el.style.opacity = String(Math.sin(Math.PI * t) * 0.95 + 0.05);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ── 右侧：直播流 ─────────────────────────────────────────────────────── */

function feedSignature() {
  const w = state.world;
  if (!w) return '';
  const last = w.messages[w.messages.length - 1];
  return `${w.id}:${w.messages.length}:${last?.id || ''}:${state.live ? state.live.agentId : ''}`;
}

function renderFeed() {
  const feed = $('#feed');
  const scroller = $('.tab-body');
  const w = state.world;
  if (!w) {
    feed.innerHTML = '<div class="feed-empty"><b>世界尚未开始</b>写下目标，点亮议会。</div>';
    return;
  }
  const sig = feedSignature();
  if (sig === state.feedSig && !state.live) {
    maybeAutoScroll();
    updateTabCounts();
    return;
  }
  state.feedSig = sig;
  const wasNearBottom =
    !state.feedInited || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;

  const messages = w.messages;
  if (!messages.length && !state.live) {
    feed.innerHTML =
      '<div class="feed-empty"><b>静默中</b>第一句发言即将出现。你也可以随时插话。</div>';
    updateTabCounts();
    return;
  }

  feed.innerHTML = messages.map((m) => entryHtml(m, w)).join('') + (state.live ? liveEntryHtml(w) : '');
  updateTabCounts();
  if (wasNearBottom && state.activeTab === 'live') {
    state.feedInited = true;
    requestAnimationFrame(() => {
      if (state.activeTab === 'live') scroller.scrollTop = scroller.scrollHeight;
    });
  }
}

function entryHtml(m, w) {
  const isHuman = m.from === 'human';
  const kind = isHuman ? 'human' : m.kind || 'broadcast';
  const glyph = isHuman ? '人' : m.fromName?.slice(0, 1);
  const color = isHuman ? '#F2EAD8' : m.fromColor || '#9FB4C7';
  const targets = m.to?.length ? m.to.map((x) => `@${x}`).join(' ') : '';
  const chips = [];
  if (kind === 'final') chips.push('<span class="chip final">交付物</span>');
  if (kind === 'plan') chips.push('<span class="chip">计划</span>');
  if (m.markers?.tasks?.length) {
    for (const t of m.markers.tasks) {
      chips.push(
        `<span class="chip task-done">#${t.id} ${t.status === 'done' ? '完成' : '阻塞'}</span>`,
      );
    }
  }
  if (m.markers?.memories) chips.push('<span class="chip mem">记忆 +1</span>');
  if (m.markers?.conflicts) chips.push('<span class="chip conflict">交接冲突</span>');

  const text = renderMarkdown(m.text || '', w);
  return `<article class="entry" data-kind="${kind}" style="--c:${color}">
    <header class="entry-head">
      <span class="entry-orb">${escapeHtml(glyph || '·')}</span>
      <span class="entry-name">${escapeHtml(isHuman ? '人类' : m.fromName || '系统')}</span>
      <span class="entry-role">${escapeHtml(isHuman ? '指令' : m.fromRole || '')}</span>
      ${targets ? `<span class="entry-role entry-target">→ ${escapeHtml(targets)}</span>` : ''}
      <span class="entry-turn">T${String(m.turn ?? 0).padStart(2, '0')} · ${timeOf(m.ts)}</span>
    </header>
    <div class="entry-text">${text}</div>
    ${chips.length ? `<div class="entry-foot">${chips.join('')}</div>` : ''}
  </article>`;
}

function liveEntryHtml(w) {
  const a = agentById(state.live.agentId);
  if (!a) return '';
  return `<article class="entry" data-kind="live" style="--c:${a.color}">
    <header class="entry-head">
      <span class="entry-orb">${escapeHtml(a.glyph)}</span>
      <span class="entry-name">${escapeHtml(a.name)}</span>
      <span class="entry-role">${escapeHtml(a.role)}</span>
      <span class="entry-turn">T${String((w.turn || 0) + 1).padStart(2, '0')} · 正在说</span>
    </header>
    <div class="entry-text" id="liveText">${escapeHtml(state.live.text)}<span class="caret"></span></div>
  </article>`;
}

function maybeAutoScroll() {
  if (state.activeTab !== 'live') return;
  const scroller = $('.tab-body');
  if (!scroller) return;
  if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140) {
    requestAnimationFrame(() => {
      if (state.activeTab === 'live') scroller.scrollTop = scroller.scrollHeight;
    });
  }
}

/* 轻量 Markdown：标题、列表、粗体、行内代码、@提及 */
function renderMarkdown(text, w) {
  const names = (w?.agents || []).map((a) => a.name).sort((a, b) => b.length - a.length);
  const escape = escapeHtml(text);
  const lines = escape.split('\n');
  const out = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<ul>${list.join('')}</ul>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*·]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)、]\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h3>${decorate(heading[2], names)}</h3>`);
      continue;
    }
    if (bullet || numbered) {
      flushPara();
      if (!list) list = [];
      list.push(`<li>${decorate((bullet || numbered)[1], names)}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(decorate(line, names));
  }
  flushPara();
  flushList();
  return out.join('');
}

function decorate(escaped, names) {
  let html = escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  for (const name of names) {
    const re = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    html = html.replace(re, `<span class="mention">@${name}</span>`);
  }
  return html;
}

function setTyping(agentId, focus) {
  const feedHint = $('#feedHint');
  if (!feedHint) return;
  if (!agentId) {
    feedHint.textContent = '实时信号流';
    return;
  }
  const a = agentById(agentId);
  feedHint.textContent = focus ? `${a?.name || ''} · ${focus}` : `${a?.name || ''} 正在思考`;
}

/* ── 右侧：任务 / 记忆 / 日志 ─────────────────────────────────────────── */

function renderTasks() {
  const el = $('#taskList');
  const tasks = state.world?.tasks || [];
  if (!tasks.length) {
    el.innerHTML = '<div class="panel-empty">指挥家正在拆解目标…</div>';
    return;
  }
  el.innerHTML = tasks
    .map((t) => {
      const pending = (t.dependsOn || []).filter(
        (id) => state.world.tasks.find((x) => x.id === id)?.status !== 'done',
      );
      return `<div class="task" data-status="${t.status}" data-id="${t.id}">
        <button class="task-check" data-task="${t.id}" title="点击切换状态">${t.status === 'done' ? '✓' : ''}</button>
        <div>
          <div class="task-title">#${t.id} ${escapeHtml(t.title)}</div>
          <div class="task-meta">
            <span class="task-status">${t.status}</span>
            <span>${escapeHtml(t.owner || '未指派')}</span>
            ${
              pending.length
                ? `<span class="task-wait">等 ${pending.map((d) => `#${d}`).join('、')}</span>`
                : ''
            }
            ${
              t.completedBy && t.completedBy !== t.owner
                ? `<span>by ${escapeHtml(t.completedBy)}</span>`
                : ''
            }
          </div>
          ${t.note ? `<div class="task-note">${escapeHtml(t.note)}</div>` : ''}
          ${
            t.artifact
              ? `<div class="task-artifact"><b>${escapeHtml(t.artifact.by)} 的交接</b><span>${escapeHtml(
                  t.artifact.text,
                )}</span></div>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
}

function renderMemory() {
  const el = $('#memoryList');
  const memory = state.world?.memory || [];
  if (!memory.length) {
    el.innerHTML =
      '<div class="panel-empty">长期记忆为空。<br>智能体用 <code>[[remember: …]]</code> 写入关键事实。</div>';
    return;
  }
  el.innerHTML = memory
    .slice()
    .reverse()
    .map(
      (m) => `<div class="memory">
        <p>${escapeHtml(m.text)}</p>
        <span>${escapeHtml(m.by)} · ${timeOf(m.ts)}</span>
      </div>`,
    )
    .join('');
}

function renderLogs() {
  const el = $('#logList');
  const logs = state.world?.logs || [];
  if (!logs.length) {
    el.innerHTML = '<div class="panel-empty">还没有事件。</div>';
    return;
  }
  el.innerHTML = logs
    .slice(-120)
    .map(
      (l) => `<div class="log-row" data-level="${l.level}">
        <span class="t">${timeOf(l.ts)}</span><span class="d"></span><span>${escapeHtml(l.text)}</span>
      </div>`,
    )
    .join('');
}

function updateTabCounts() {
  const w = state.world;
  const msgCount = w?.messages.length || 0;
  $('#liveCount').textContent = String(msgCount);
  const tasks = w?.tasks || [];
  const done = tasks.filter((t) => t.status === 'done').length;
  $('#taskCount').textContent = tasks.length ? `${done}/${tasks.length}` : '0';
}

/* ── 交互：舞台平移 / 缩放 / 拖动 ─────────────────────────────────────── */

function applyTransform() {
  $('#viewport').style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
}

function bindStageInteractions() {
  const stage = $('#stage');
  let panning = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node') || e.target.closest('button')) return;
    panning = { x: e.clientX, y: e.clientY, px: state.pan.x, py: state.pan.y };
    stage.classList.add('is-panning');
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener('pointermove', (e) => {
    if (!panning) return;
    state.pan.x = panning.px + (e.clientX - panning.x);
    state.pan.y = panning.py + (e.clientY - panning.y);
    applyTransform();
  });

  const stopPan = () => {
    panning = null;
    stage.classList.remove('is-panning');
  };
  stage.addEventListener('pointerup', stopPan);
  stage.addEventListener('pointercancel', stopPan);
  stage.addEventListener('pointerleave', stopPan);

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      state.zoom = clamp(state.zoom * factor, 0.45, 1.9);
      applyTransform();
    },
    { passive: false },
  );

  $$('[data-zoom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.zoom;
      if (action === 'in') state.zoom = clamp(state.zoom * 1.15, 0.45, 1.9);
      else if (action === 'out') state.zoom = clamp(state.zoom / 1.15, 0.45, 1.9);
      else {
        state.zoom = 1;
        state.pan = { x: 0, y: 0 };
      }
      applyTransform();
    });
  });
}

function bindNodeDrag(node, agentId) {
  let drag = null;
  const el = node.el;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag = { x: e.clientX, y: e.clientY, ox: node.offX, oy: node.offY, moved: false };
    el.classList.add('is-dragging');
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / state.zoom;
    const dy = (e.clientY - drag.y) / state.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    node.offX = drag.ox + dx;
    node.offY = drag.oy + dy;
    applyNodePos(node);
    drawEdges();
  });

  const end = () => {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    el.classList.remove('is-dragging');
    if (!wasMoved) focusAgent(agentId);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function focusAgent(agentId) {
  const a = agentById(agentId);
  if (!a) return;
  state.selectedAgentId = agentId;
  renderRoster();
  if (!a.lastLine) return;
  const node = state.nodes.get(agentId);
  if (!node) return;
  node.el.classList.add('has-bubble');
  const bubble = $('.node-bubble', node.el);
  if (bubble) bubble.textContent = a.lastLine;
  clearTimeout(state.bubbleTimers.get(agentId));
  state.bubbleTimers.set(
    agentId,
    setTimeout(() => node.el.classList.remove('has-bubble'), 5000),
  );
}

/* ── 交互：控制 / 发送 / 标签页 ───────────────────────────────────────── */

function bindStatic() {
  bindStageInteractions();

  $('#btnRun').addEventListener('click', async () => {
    const status = state.world?.status;
    try {
      if (status === 'paused') {
        await api('/api/world/resume', { method: 'POST', body: {} });
      } else {
        await api('/api/world/start', { method: 'POST', body: {} });
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btnPause').addEventListener('click', async () => {
    try {
      await api('/api/world/pause', { method: 'POST', body: {} });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btnStop').addEventListener('click', async () => {
    try {
      await api('/api/world/stop', { method: 'POST', body: {} });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btnExport').addEventListener('click', () => {
    if (!state.world) return toast('还没有可以导出的世界');
    window.location.href = '/api/export';
  });

  $('#btnReset').addEventListener('click', async () => {
    if (!state.world) return;
    if (!confirm('重置会清空对话、任务板与记忆，但保留成员。继续？')) return;
    try {
      await api('/api/world/reset', { method: 'POST', body: { keepAgents: true } });
      state.nodes.forEach((n) => n.el.remove());
      state.nodes.clear();
      state.feedSig = '';
      toast('世界已重置');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $$('.panel').forEach((p) => {
        p.classList.toggle('is-active', p.id === `panel${cap(state.activeTab)}`);
      });
      if (state.activeTab === 'live') {
        const scroller = $('.tab-body');
        requestAnimationFrame(() => {
          if (state.activeTab === 'live') scroller.scrollTop = scroller.scrollHeight;
        });
      } else {
        const scroller = $('.tab-body');
        requestAnimationFrame(() => {
          if (state.activeTab !== 'live') scroller.scrollTop = 0;
        });
      }
    });
  });

  $('#taskList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-task]');
    if (!btn) return;
    const id = btn.dataset.task;
    const task = state.world?.tasks.find((t) => String(t.id) === String(id));
    if (!task) return;
    const order = ['todo', 'doing', 'done'];
    const next = order[(order.indexOf(task.status) + 1) % order.length] || 'todo';
    try {
      await api(`/api/tasks/${id}`, { method: 'POST', body: { status: next } });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#roster').addEventListener('click', (e) => {
    const btn = e.target.closest('.member');
    if (!btn) return;
    focusAgent(btn.dataset.id);
    if (e.detail >= 2) openAgentDialog(btn.dataset.id);
  });

  $('#roster').addEventListener('dblclick', (e) => {
    const btn = e.target.closest('.member');
    if (btn) openAgentDialog(btn.dataset.id);
  });

  $('#sayInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#sayInput').addEventListener('input', updateComposerTarget);
  $('#btnSend').addEventListener('click', sendMessage);

  $('#btnAddAgent').addEventListener('click', () => openAgentDialog(null));
  document.querySelector('[data-act="providers"]').addEventListener('click', openProviderDialog);

  const togglePanels = $('#btnTogglePanels');
  if (togglePanels) {
    togglePanels.addEventListener('click', () => {
      $('.rail-right').classList.toggle('is-open');
    });
  }
  const toggleRail = $('#btnToggleRail');
  if (toggleRail) {
    toggleRail.addEventListener('click', () => {
      $('.rail-left').classList.toggle('is-open');
    });
  }
  $$('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => document.getElementById(btn.dataset.close).close()),
  );

  bindAgentDialog();
  bindProviderDialog();
  bindGenesis();

  window.addEventListener('resize', () => {
    layoutNodes();
    drawEdges();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal[open]').forEach((d) => d.close());
    }
    if (e.key === '/' && document.activeElement !== $('#sayInput') && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      $('#sayInput').focus();
    }
  });
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function updateComposerTarget() {
  const value = $('#sayInput').value;
  const chip = $('#composerTarget');
  const m = value.match(/^\s*@([\w\u4e00-\u9fa5·-]+)/u);
  const agent = m ? agentByName(m[1]) : null;
  if (agent) {
    chip.hidden = false;
    chip.textContent = `私信 ${agent.name}`;
  } else {
    chip.hidden = true;
  }
}

async function sendMessage() {
  const input = $('#sayInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.world) return toast('请先创建世界');
  input.value = '';
  $('#composerTarget').hidden = true;
  try {
    await api('/api/message', { method: 'POST', body: { text } });
    maybeAutoScroll();
  } catch (err) {
    toast(err.message, 'error');
    input.value = text;
  }
}

/* ── 成员编辑 ─────────────────────────────────────────────────────────── */

function fillPersonaOptions() {
  const sel = $('#personaSelect');
  sel.innerHTML =
    '<option value="custom">自定义</option>' +
    state.personas.map((p) => `<option value="${p.key}">${p.name} · ${p.role}</option>`).join('');
}

function fillProviderOptions(select, current) {
  select.innerHTML = state.providers
    .map(
      (p) =>
        `<option value="${p.id}"${p.id === current ? ' selected' : ''}>${p.name}${p.usable ? '' : '（未配置）'}</option>`,
    )
    .join('');
}

function openAgentDialog(agentId) {
  const dialog = $('#agentDialog');
  const form = $('#agentForm');
  form.reset();
  state.editingAgentId = agentId;
  fillPersonaOptions();
  const agent = agentId ? agentById(agentId) : null;
  $('#agentDialogTitle').textContent = agent ? `编辑 ${agent.name}` : '添加成员';

  const providerId = agent?.providerId || state.providers.find((p) => p.usable)?.id || 'mock';
  fillProviderOptions($('#agentProvider'), providerId);

  if (agent) {
    form.elements.name.value = agent.name;
    form.elements.role.value = agent.role;
    form.elements.glyph.value = agent.glyph;
    form.elements.color.value = agent.color;
    form.elements.personaKey.value = agent.personaKey || 'custom';
    form.elements.model.value = agent.model;
    form.elements.kind.value = agent.kind;
    form.elements.system.value = agent.system || '';
    form.elements.isConductor.checked = Boolean(agent.isConductor);
    form.elements.isConductor.disabled = true;
  } else {
    form.elements.color.value = '#6FD3E8';
    const persona = state.personas.find((p) => p.key === 'scout');
    if (persona) {
      form.elements.name.value = '';
      form.elements.role.value = persona.role;
      form.elements.glyph.value = persona.glyph;
      form.elements.color.value = persona.color;
    }
    form.elements.model.value = state.providers.find((p) => p.id === providerId)?.models?.[0] || '';
    form.elements.kind.value = 'llm';
  }

  const del = form.querySelector('#agentDelete') || document.createElement('button');
  if (!del.id) {
    del.id = 'agentDelete';
    del.className = 'btn danger';
    del.type = 'button';
    del.textContent = '移除成员';
    del.style.marginRight = 'auto';
    form.querySelector('.modal-foot').prepend(del);
    del.addEventListener('click', async () => {
      if (!state.editingAgentId) return;
      if (!confirm('确定让这个成员离开世界？')) return;
      try {
        await api(`/api/agents/${state.editingAgentId}`, { method: 'DELETE' });
        dialog.close();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  del.hidden = !agent;

  $('#agentHint').textContent =
    '外部程序接入的成员不会调用模型：轮到你时，世界会等待你用 POST /api/say 或 npm run say 投递内容。';
  dialog.showModal();
}

function bindAgentDialog() {
  const dialog = $('#agentDialog');
  const form = $('#agentForm');

  $('#personaSelect').addEventListener('change', (e) => {
    const persona = state.personas.find((p) => p.key === e.target.value);
    if (!persona || state.editingAgentId) return;
    form.elements.name.value = persona.name;
    form.elements.role.value = persona.role;
    form.elements.glyph.value = persona.glyph;
    form.elements.color.value = persona.color;
  });

  $('#agentProvider').addEventListener('change', (e) => {
    const provider = state.providers.find((p) => p.id === e.target.value);
    if (provider) form.elements.model.value = provider.models?.[0] || '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter?.value === 'cancel') {
      dialog.close();
      return;
    }
    const fd = new FormData(form);
    const payload = {
      name: String(fd.get('name') || '').trim(),
      role: String(fd.get('role') || '').trim(),
      glyph: String(fd.get('glyph') || '').trim(),
      color: String(fd.get('color') || ''),
      personaKey: String(fd.get('personaKey') || 'custom'),
      providerId: String(fd.get('providerId') || 'mock'),
      model: String(fd.get('model') || '').trim(),
      kind: String(fd.get('kind') || 'llm'),
      system: String(fd.get('system') || '').trim(),
      isConductor: fd.get('isConductor') === 'on',
    };
    if (!payload.name) return toast('请给成员起个名字');
    try {
      if (state.editingAgentId) {
        await api(`/api/agents/${state.editingAgentId}`, {
          method: 'PATCH',
          body: { ...payload, isConductor: undefined },
        });
      } else {
        await api('/api/agents', { method: 'POST', body: payload });
      }
      dialog.close();
      toast('成员已就位');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ── 模型与世界 ───────────────────────────────────────────────────────── */

function openProviderDialog() {
  renderProviderList();
  renderConfigInputs();
  const dialog = $('#providerDialog');
  if (!dialog.open) dialog.showModal();
}

function renderProviderList() {
  const el = $('#providerList');
  if (!el) return;
  el.innerHTML = state.providers
    .map((p) => {
      const label = p.kind === 'mock' ? '可用' : p.local && !p.hasKey ? '本地' : p.usable ? '可用' : '未配置';
      const badgeClass = label === '可用' ? 'on' : label === '本地' ? 'local' : 'off';
      return `<div class="provider-row">
        <div>
          <div class="p-name">${escapeHtml(p.name)}
            <span class="badge ${badgeClass}">${label}</span>
            ${p.builtin ? '' : '<span class="badge">自定义</span>'}
          </div>
          <div class="p-meta">${escapeHtml(p.baseUrl || '内置模拟器')}${
            p.keyMask ? ` · key ${escapeHtml(p.keyMask)}` : p.env ? ` · 环境变量 ${p.env}` : ''
          }<br>${escapeHtml((p.models || []).join(', '))}</div>
        </div>
        ${
          p.builtin
            ? '<span class="micro">BUILT-IN</span>'
            : `<button class="mini" data-remove-provider="${p.id}">删除</button>`
        }
      </div>`;
    })
    .join('');
}

function renderConfigInputs() {
  const cfg = state.world?.config;
  if (!cfg) return;
  const maxTurns = $('#cfgMaxTurns');
  if (maxTurns && document.activeElement !== maxTurns) {
    maxTurns.value = cfg.maxTurns;
    $('#cfgDelay').value = cfg.turnDelayMs;
    $('#cfgModerator').value = cfg.moderator === 'rules' ? 'rules' : 'llm';
  }
}

function bindProviderDialog() {
  $('#providerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    try {
      const data = await api('/api/providers', {
        method: 'POST',
        body: {
          name: String(fd.get('name') || '').trim(),
          baseUrl: String(fd.get('baseUrl') || '').trim(),
          apiKey: String(fd.get('apiKey') || '').trim(),
          models: String(fd.get('models') || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      state.providers = data.providers;
      renderProviderList();
      syncGenesisProviders();
      form.reset();
      toast('端点已保存');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#providerList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove-provider]');
    if (!btn) return;
    try {
      await api(`/api/providers/${btn.dataset.removeProvider}`, { method: 'DELETE' });
      const data = await api('/api/state');
      state.providers = data.providers;
      renderProviderList();
      syncGenesisProviders();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btnSaveConfig').addEventListener('click', async () => {
    if (!state.world) return toast('先创建世界');
    try {
      await api('/api/world/config', {
        method: 'POST',
        body: {
          maxTurns: clamp(Number($('#cfgMaxTurns').value) || 24, 4, 200),
          turnDelayMs: clamp(Number($('#cfgDelay').value) || 0, 0, 10000),
          moderator: $('#cfgModerator').value,
        },
      });
      toast('世界参数已更新');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ── 创世 ─────────────────────────────────────────────────────────────── */

const PRESETS = [
  '为一款面向独立开发者的记账 App 设计技术方案，并给出 4 周落地计划。',
  '研究「小团队为什么难以坚持写文档」，给出可执行的改进机制。',
  '写一篇 1500 字的深度文章：AI 时代，个体工程师的核心竞争力是什么。',
  '设计一个离线优先的团队知识库产品，输出信息架构与关键交互。',
];

function initRosterPicks() {
  const presets = $('#presets');
  presets.innerHTML = PRESETS.map((p) => `<button type="button" class="preset">${escapeHtml(shortText(p, 22))}</button>`).join('');
  presets.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset');
    if (!btn) return;
    const idx = [...presets.children].indexOf(btn);
    $('#goalInput').value = PRESETS[idx] || '';
    $('#goalInput').focus();
  });
}

const shortText = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/* ── 阵容与模型分配 ─────────────────────────────────────────────────── */

function ensureGenesisMembers() {
  if (state.genesisMembers.length) return;
  const defaults = (state.defaults?.roster || []).filter((k) =>
    state.personas.some((p) => p.key === k),
  );
  state.genesisMembers = defaults.length
    ? [...defaults]
    : state.personas.slice(0, 5).map((p) => p.key);
  if (!state.genesisMembers.includes('conductor') && state.personas.some((p) => p.key === 'conductor')) {
    state.genesisMembers.unshift('conductor');
  }
}

function memberPersonas() {
  return state.genesisMembers
    .map((key) => state.personas.find((p) => p.key === key))
    .filter(Boolean);
}

/** 可用端点 × 模型，构成轮转池。只自动使用真正配置过密钥的端点；本地端点留给手动选择 */
function modelPool() {
  const real = state.providers.filter((p) => p.usable && p.hasKey);
  const mock = state.providers.find((p) => p.kind === 'mock');
  const bases = real.length ? real : mock ? [mock] : [];
  const pool = [];
  for (const p of bases) {
    for (const m of (p.models || []).slice(0, 4)) {
      if (m) pool.push({ providerId: p.id, model: m, providerName: p.name });
    }
  }
  return pool.length
    ? pool
    : [{ providerId: 'mock', model: 'confluence-mock', providerName: '离线模拟器' }];
}

function assignmentsFor(members) {
  const provider =
    state.providers.find((p) => p.id === state.genesisProvider) || state.providers[0];
  const sharedModel =
    $('#modelInput')?.value.trim() || provider?.models?.[0] || 'confluence-mock';
  if (state.genesisModelMode !== 'auto') {
    return members.map(() => ({
      providerId: provider?.id || 'mock',
      model: sharedModel,
      providerName: provider?.name || '离线模拟器',
    }));
  }
  const pool = modelPool();
  return members.map((_, i) => pool[i % pool.length]);
}

function renderRosterPicks() {
  ensureGenesisMembers();
  const el = $('#rosterPick');
  el.innerHTML = state.personas
    .map((p) => {
      const on = state.genesisMembers.includes(p.key);
      return `<button type="button" class="pick${on ? ' is-on' : ''}" data-key="${p.key}" style="--c:${p.color}" title="${
        on ? '点击移除此成员' : '点击加入此成员'
      }">
        <span class="g">${escapeHtml(p.glyph)}</span>
        <span>${escapeHtml(p.name)}</span>
        <span class="r">${escapeHtml(p.role)}</span>
      </button>`;
    })
    .join('');
  const count = $('#memberCount');
  if (count) count.textContent = String(state.genesisMembers.length);
  renderMemberPreview();
}

function renderMemberPreview() {
  const el = $('#memberPreview');
  if (!el) return;
  const members = memberPersonas();
  const assignments = assignmentsFor(members);
  el.innerHTML = members
    .map((p, i) => {
      const a = assignments[i] || {};
      const provider = state.providers.find((x) => x.id === a.providerId);
      const modelLabel = `${provider?.name || a.providerId || '—'} · ${a.model || '—'}`;
      return `<div class="mp-row${p.isConductor ? ' is-conductor' : ''}" style="--c:${p.color}">
        <span class="g">${escapeHtml(p.glyph)}</span>
        <b>${escapeHtml(p.name)}</b>
        <span>${escapeHtml(p.role)}</span>
        <code title="${escapeHtml(modelLabel)}">${escapeHtml(modelLabel)}</code>
      </div>`;
    })
    .join('');
}

function updateModelModeVisibility() {
  const auto = state.genesisModelMode === 'auto';
  const sharedRow = $('#sharedModelRow');
  const sharedCell = $('#sharedProviderCell');
  if (sharedRow) sharedRow.hidden = auto;
  if (sharedCell) sharedCell.hidden = auto;
}

function syncGenesisProviders() {
  const select = $('#providerSelect');
  if (!select) return;
  ensureGenesisMembers();
  if (!select.dataset.bound) {
    select.dataset.bound = '1';
    select.addEventListener('change', () => {
      state.genesisProvider = select.value;
      const provider = state.providers.find((p) => p.id === select.value);
      const input = $('#modelInput');
      if (provider && input) input.value = provider.models?.[0] || '';
      updateGenesisHint();
      renderMemberPreview();
    });
  }

  const preferred =
    state.providers.find((p) => p.usable && p.kind !== 'mock' && p.hasKey)?.id ||
    state.providers.find((p) => p.usable)?.id ||
    'mock';
  if (!select.options.length) state.genesisProvider = preferred;

  select.innerHTML = state.providers
    .map(
      (p) =>
        `<option value="${p.id}"${p.id === state.genesisProvider ? ' selected' : ''}>${p.name}${
          p.usable ? '' : '（未配置）'
        }</option>`,
    )
    .join('');
  state.genesisProvider = select.value || preferred;

  // 首次进入：有多个可用模型时默认自动分配，否则统一使用
  if (!state.genesisModeInited) {
    state.genesisModeInited = true;
    const distinct = new Set(modelPool().map((x) => `${x.providerId}/${x.model}`));
    const hasReal = state.providers.some((p) => p.usable && p.hasKey);
    state.genesisModelMode = distinct.size >= 2 && hasReal ? 'auto' : 'shared';
  }
  const mode = $('#modelMode');
  if (mode) mode.value = state.genesisModelMode;

  updateModelModeVisibility();
  updateGenesisHint();
  renderMemberPreview();
}

function updateGenesisHint() {
  const provider = state.providers.find((p) => p.id === state.genesisProvider);
  const modelInput = $('#modelInput');
  const list = $('#modelList');
  if (provider) {
    list.innerHTML = (provider.models || [])
      .map((m) => `<option value="${escapeHtml(m)}"></option>`)
      .join('');
    if (!modelInput.value) modelInput.value = provider.models?.[0] || '';
  }
  const hint = $('#keyHint');
  if (state.genesisModelMode === 'auto') {
    const pool = modelPool();
    const distinct = new Set(pool.map((x) => `${x.providerId}/${x.model}`));
    const sources = [...new Set(pool.map((x) => x.providerName))].join('、');
    hint.textContent = `自动分配：从 ${sources || '离线模拟器'} 的 ${distinct.size} 个模型中轮流分配，每个成员的模型会显示在上面；不足时循环使用。`;
    return;
  }
  if (!provider) {
    hint.textContent = '';
    return;
  }
  if (provider.kind === 'mock') {
    hint.textContent = '离线模拟器：不调用任何模型，生成连贯的协作内容，适合先看效果与流程。';
  } else if (!provider.usable) {
    hint.textContent = `尚未检测到密钥。设置环境变量 ${provider.env || 'API Key'} 后重启服务，或改用离线模拟器。`;
  } else if (provider.hasKey) {
    hint.textContent = `已连接 ${provider.name} · ${provider.keyMask || ''}。所有成员使用同一个模型，创建后可在成员编辑里单独调整。`;
  } else {
    hint.textContent = `本地端点 ${provider.baseUrl}。如未启动服务，创建后会看到连接错误。`;
  }
}

function addMember() {
  ensureGenesisMembers();
  if (state.genesisMembers.length >= state.personas.length) {
    toast(`最多 ${state.personas.length} 位成员`);
    return;
  }
  const next = state.personas.find((p) => !state.genesisMembers.includes(p.key));
  if (!next) return;
  state.genesisMembers.push(next.key);
  renderRosterPicks();
}

function removeMember() {
  ensureGenesisMembers();
  if (state.genesisMembers.length <= 2) {
    toast('至少保留两位成员');
    return;
  }
  const last = [...state.genesisMembers].reverse().find((k) => k !== 'conductor');
  if (!last) return;
  state.genesisMembers = state.genesisMembers.filter((k) => k !== last);
  renderRosterPicks();
}

function bindGenesis() {
  $('#rosterPick').addEventListener('click', (e) => {
    const btn = e.target.closest('.pick');
    if (!btn) return;
    const key = btn.dataset.key;
    const selected = state.genesisMembers.includes(key);
    if (selected) {
      if (key === 'conductor') return toast('指挥家是议会的中枢，不能取消');
      if (state.genesisMembers.length <= 2) return toast('至少保留两位成员');
      state.genesisMembers = state.genesisMembers.filter((k) => k !== key);
    } else {
      if (state.genesisMembers.length >= state.personas.length) return toast('成员已满');
      state.genesisMembers.push(key);
    }
    renderRosterPicks();
  });

  $('#btnMemberPlus').addEventListener('click', addMember);
  $('#btnMemberMinus').addEventListener('click', removeMember);

  $('#modelMode').addEventListener('change', (e) => {
    state.genesisModelMode = e.target.value === 'shared' ? 'shared' : 'auto';
    updateModelModeVisibility();
    updateGenesisHint();
    renderMemberPreview();
  });

  $('#modelInput').addEventListener('input', renderMemberPreview);

  $('#btnCreate').addEventListener('click', createWorld);
  $('#goalInput').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') createWorld();
  });
}

async function createWorld() {
  const goal = $('#goalInput').value.trim();
  if (!goal) {
    toast('先写下你想让它们完成的事');
    $('#goalInput').focus();
    return;
  }
  ensureGenesisMembers();
  const members = memberPersonas();
  if (!members.length) return toast('至少选一个成员');
  if (!members.some((p) => !p.isConductor)) return toast('至少需要一位可以发言的成员');

  const assignments = assignmentsFor(members);
  const agents = members.map((p, i) => ({
    name: p.name,
    role: p.role,
    glyph: p.glyph,
    color: p.color,
    personaKey: p.key,
    isConductor: Boolean(p.isConductor),
    providerId: assignments[i]?.providerId || 'mock',
    model: assignments[i]?.model || 'confluence-mock',
  }));

  const btn = $('#btnCreate');
  btn.disabled = true;
  btn.textContent = '正在点亮…';
  try {
    const data = await api('/api/world', {
      method: 'POST',
      body: { goal, agents },
    });
    applySnapshot(data.world);
    hideGenesis();
    toast(`议会已点亮：${agents.length} 位成员`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '点亮议会 →';
  }
}

function showGenesis() {
  const el = $('#genesis');
  el.classList.remove('is-hidden');
  ensureGenesisMembers();
  renderRosterPicks();
  syncGenesisProviders();
}

function hideGenesis() {
  $('#genesis').classList.add('is-hidden');
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */

boot();

// Swarm Studio UI: hash-routed single page, live updates over SSE.
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => DOMPurify.sanitize(marked.parse(String(s || '')));
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const pad = (n) => String(n).padStart(2, '0');
const STANCES = ['supportive', 'opposing', 'neutral', 'observer'];
const PALETTE = ['#8b5cf6', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#fb923c', '#a3e635', '#e879f9', '#94a3b8'];
const STEPS = [['graph', 'Graph'], ['setup', 'Setup'], ['simulation', 'Simulation'], ['report', 'Report'], ['interact', 'Interact']];
const STAGE_ORDER = ['created', 'ingest', 'ontology', 'graph', 'personas', 'config', 'ready'];
const WRITES = new Set(['CREATE_POST', 'QUOTE_POST', 'CREATE_COMMENT']);
const VERB = {
  CREATE_POST: 'posted', QUOTE_POST: 'quoted', REPOST: 'reposted', LIKE_POST: 'liked', DISLIKE_POST: 'downvoted',
  CREATE_COMMENT: 'commented', LIKE_COMMENT: 'upvoted a comment', DISLIKE_COMMENT: 'downvoted a comment', FOLLOW: 'followed', MUTE: 'muted',
};

async function api(path, { body, method } = {}) {
  const r = await fetch(`/api${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

const S = {
  auth: null,
  sims: [],
  draft: { files: [], text: '', requirement: '', agents: 150, rounds: 30, auto: true },
  sim: null,
  es: null,
  tab: 'graph',
  follow: true,
  layout: 'split',
  personaFilter: 'all',
  feedMode: 'all',
  runRounds: null,
  interactTab: 'report',
  chats: { report: [], agent: {} },
  drafts: {},
  pending: false,
  chatSteps: [],
  interviewAgent: null,
  survey: { picked: new Set(), results: [], filter: 'all' },
  selected: null,
};

// ---------- routing ----------
function route() {
  const [, view, id, tab] = location.hash.split('/');
  if (view === 'sim' && id) openSim(id, tab);
  else showHome();
}
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => G.svg && centerGraph());

// =====================================================================
// Home
// =====================================================================
function estimate(agents, rounds) {
  const perRound = 2 * Math.ceil(Math.min(60, agents * 0.22) / 12);
  const prep = 10 + Math.ceil(agents / 10);
  const total = prep + rounds * perRound + 8;
  const minutes = Math.round((rounds * Math.ceil(perRound / 6) * 22 + (prep / 6) * 55 + 300) / 60);
  return { total, minutes };
}

function showHome() {
  closeSim();
  const d = S.draft;
  app.innerHTML = `
  <nav class="nav"><a class="brand" href="#/"><span class="orb"></span>Swarm Studio</a><span class="grow"></span><span id="auth-chip"></span></nav>
  <main class="home">
    <div id="auth-banner"></div>
    <section class="hero">
      <h1>Rehearse the future<br><span>before it happens.</span></h1>
      <p>Drop in the source material and ask what happens next. Claude builds a knowledge graph, casts every actor and a crowd of the public as agents, and plays them out on a simulated microblog and forum, then writes the prediction report.</p>
      <div class="steps-strip">${['Knowledge graph', 'Agent personas', 'Dual-platform simulation', 'Prediction report', 'Interview anyone'].map((s, i) => `<span class="chip"><span class="mono dim">0${i + 1}</span>${s}</span>`).join('')}</div>
    </section>
    <section class="new-grid">
      <div class="card">
        <div class="label" style="margin-bottom:12px">Seed material</div>
        <label class="drop" id="drop">
          <input type="file" id="file-in" multiple accept=".pdf,.md,.markdown,.txt" hidden>
          <div style="font-size:15px;font-weight:600">Drop PDFs, Markdown or text files</div>
          <div class="muted" style="font-size:13px;margin-top:4px">news, a launch plan, a policy draft, a report, a story</div>
        </label>
        <div class="files" id="files"></div>
        <div class="field" style="margin:16px 0 0">
          <span class="label">Or paste text</span>
          <textarea id="paste" rows="6" placeholder="Paste an article, memo or thread…">${esc(d.text)}</textarea>
        </div>
      </div>
      <div class="card">
        <div class="field">
          <span class="label">What do you want to predict?</span>
          <textarea id="req" rows="4" placeholder="e.g. How will developers and the press react to our pricing change over the first 72 hours?">${esc(d.requirement)}</textarea>
        </div>
        <div class="slider-row">
          <div class="field"><div class="slider-head"><span class="label">Agents</span><b id="agents-v">${d.agents}</b></div><input type="range" id="agents" min="10" max="300" step="10" value="${d.agents}"></div>
          <div class="field"><div class="slider-head"><span class="label">Rounds</span><b id="rounds-v">${d.rounds}</b></div><input type="range" id="rounds" min="2" max="60" step="1" value="${d.rounds}"></div>
        </div>
        <div class="estimate" id="estimate"></div>
        <label class="check"><input type="checkbox" id="auto" ${d.auto ? 'checked' : ''}>Run every step automatically (graph → simulation → report)</label>
        <button class="btn primary" id="start" style="width:100%;padding:13px">Start simulation</button>
      </div>
    </section>
    <section class="history"><h2>Past simulations</h2><div class="hist-grid" id="hist"></div></section>
  </main>`;

  const renderFiles = () => {
    $('#files').innerHTML = d.files.map((f, i) => `<div class="file"><span class="chip mono" style="font-size:10.5px">${esc(f.name.split('.').pop().toUpperCase())}</span>${esc(f.name)}<span class="dim mono" style="font-size:11px">${Math.ceil(f.size / 1024)} KB</span><span class="x" data-i="${i}">✕</span></div>`).join('');
  };
  const renderEstimate = () => {
    const e = estimate(d.agents, d.rounds);
    $('#estimate').innerHTML = `≈ <b>${e.total}</b> Claude calls, about <b>${e.minutes} min</b>. Runs on your Claude subscription through Claude Code (Haiku plays the crowd, Sonnet builds the world and writes the report).`;
  };
  const addFiles = async (list) => {
    for (const f of list) {
      if (!/\.(pdf|md|markdown|txt)$/i.test(f.name)) { toast(`${f.name}: only PDF, Markdown and text files`); continue; }
      const data = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] || '');
        r.readAsDataURL(f);
      });
      d.files.push({ name: f.name, size: f.size, data });
    }
    renderFiles();
  };
  renderFiles();
  renderEstimate();

  const drop = $('#drop');
  $('#file-in').onchange = (e) => addFiles(e.target.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  $('#files').onclick = (e) => { if (e.target.dataset.i) { d.files.splice(Number(e.target.dataset.i), 1); renderFiles(); } };
  $('#paste').oninput = (e) => (d.text = e.target.value);
  $('#req').oninput = (e) => (d.requirement = e.target.value);
  $('#agents').oninput = (e) => { d.agents = Number(e.target.value); $('#agents-v').textContent = d.agents; renderEstimate(); };
  $('#rounds').oninput = (e) => { d.rounds = Number(e.target.value); $('#rounds-v').textContent = d.rounds; renderEstimate(); };
  $('#auto').onchange = (e) => (d.auto = e.target.checked);
  $('#start').onclick = async (e) => {
    if (!d.requirement.trim()) return toast('Say what you want to predict.');
    if (!d.files.length && !d.text.trim()) return toast('Add a document or paste some text.');
    e.target.disabled = true;
    try {
      const meta = await api('/sims', { body: { requirement: d.requirement, text: d.text, files: d.files.map(({ name, data }) => ({ name, data })), agents: d.agents, rounds: d.rounds, auto: d.auto } });
      S.draft = { files: [], text: '', requirement: '', agents: d.agents, rounds: d.rounds, auto: d.auto };
      location.hash = `#/sim/${meta.id}`;
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  };

  loadHomeData();
}

const STATUS_STYLE = {
  created: ['Queued', 'var(--cyan)'], preparing: ['Preparing', 'var(--cyan)'], ready: ['Ready', 'var(--violet)'],
  running: ['Simulating', 'var(--cyan)'], stopping: ['Stopping', 'var(--amber)'], simulated: ['Simulated', 'var(--amber)'],
  reporting: ['Writing report', 'var(--cyan)'], reported: ['Report ready', 'var(--green)'], failed: ['Failed', 'var(--red)'],
};
const statusChip = (s) => {
  const [label, c] = STATUS_STYLE[s] || [s, 'var(--dim)'];
  const live = ['created', 'preparing', 'running', 'reporting', 'stopping'].includes(s);
  return `<span class="chip" style="color:${c};border-color:${c}55"><span class="dot ${live ? 'pulse' : ''}" style="background:${c}"></span>${label}</span>`;
};

async function loadHomeData() {
  const [auth, sims] = await Promise.all([api('/auth').catch(() => ({ loggedIn: false })), api('/sims').catch(() => [])]);
  S.auth = auth;
  S.sims = sims;
  if (!$('#hist')) return;
  $('#auth-chip').innerHTML = auth.loggedIn
    ? `<span class="chip"><span class="dot" style="background:var(--green)"></span>Claude ${auth.mock ? 'mock engine' : `signed in${auth.subscriptionType ? ` · ${esc(auth.subscriptionType)}` : ''}`}</span>`
    : `<span class="chip" style="color:var(--amber)"><span class="dot" style="background:var(--amber)"></span>Claude CLI not signed in</span>`;
  $('#auth-banner').innerHTML = auth.loggedIn ? '' : `<div class="banner">⚠️ <div>The engine runs agents through the Claude Code CLI, which isn't signed in yet. In Terminal run <code>claude auth login</code>, finish the browser sign-in with your Claude account, then reload this page.</div></div>`;
  $('#hist').innerHTML = sims.length ? sims.map((m) => `
    <div class="card hist" data-id="${m.id}">
      <button class="btn sm danger del" data-del="${m.id}">Delete</button>
      ${statusChip(m.status)}
      <h3>${esc(m.name)}</h3>
      <div class="muted" style="font-size:12.5px">${(m.docs || []).map(esc).join(', ')}</div>
      <div class="tags">
        <span class="chip mono">${m.counts?.agents ?? m.settings.agents} agents</span>
        <span class="chip mono">${m.settings.rounds} rounds</span>
        ${m.counts?.actions ? `<span class="chip mono">${m.counts.actions} actions</span>` : ''}
      </div>
      <div class="dim mono" style="font-size:11.5px;margin-top:10px">${new Date(m.created_at).toLocaleString()}</div>
    </div>`).join('') : '<div class="dim">Nothing yet. Your simulations will show up here.</div>';
  $('#hist').onclick = async (e) => {
    const del = e.target.dataset.del;
    if (del) {
      e.stopPropagation();
      if (!confirm('Delete this simulation and all its files?')) return;
      try { await api(`/sims/${del}`, { method: 'DELETE' }); loadHomeData(); } catch (err) { toast(err.message); }
      return;
    }
    const card = e.target.closest('.hist');
    if (card) location.hash = `#/sim/${card.dataset.id}`;
  };
}

// =====================================================================
// Workspace
// =====================================================================
function closeSim() {
  S.es?.close();
  S.es = null;
  S.sim = null;
  G.svg = null;
}

function steps(m) {
  const s = m.status;
  const early = STAGE_ORDER.indexOf(m.stage) <= STAGE_ORDER.indexOf('graph') && m.stage !== 'ready';
  const prepping = s === 'preparing' || s === 'created';
  const simDone = ['simulated', 'reporting', 'reported'].includes(s);
  const reached = simDone ? 4 : s === 'running' || s === 'stopping' ? 2 : s === 'ready' || !early ? 1 : 0;
  return STEPS.map(([key, label], i) => ({
    key, label,
    locked: i > reached,
    done: [!early, s === 'ready' || reached >= 2, simDone, s === 'reported', false][i],
    live: [prepping && early, prepping && !early, s === 'running' || s === 'stopping', s === 'reporting', false][i],
  }));
}

function autoTab(m) {
  if (['running', 'stopping', 'simulated'].includes(m.status)) return 'simulation';
  if (['reporting', 'reported'].includes(m.status)) return 'report';
  const early = STAGE_ORDER.indexOf(m.stage) <= STAGE_ORDER.indexOf('graph') && m.stage !== 'ready';
  return early ? 'graph' : 'setup';
}

async function openSim(id, tab) {
  if (S.sim?.meta.id !== id) {
    closeSim();
    try {
      S.sim = await api(`/sims/${id}`);
    } catch (e) {
      toast(e.message);
      location.hash = '#/';
      return;
    }
    S.chats = { report: [], agent: {} };
    S.survey = { picked: new Set(), results: [], filter: 'all' };
    S.interviewAgent = null;
    S.selected = null;
    S.runRounds = S.sim.meta.settings.rounds;
    S.follow = !tab;
    buildShell();
    connect(id);
  }
  if (tab && STEPS.some(([k]) => k === tab)) {
    S.tab = tab;
    S.follow = false;
  } else S.tab = autoTab(S.sim.meta);
  renderHead();
  renderWork();
}

function setTab(tab, manual = true) {
  if (manual) S.follow = false;
  S.tab = tab;
  history.replaceState(null, '', `#/sim/${S.sim.meta.id}/${tab}`);
  renderHead();
  renderWork();
}

function buildShell() {
  app.innerHTML = `
  <div class="ws">
    <header class="ws-head">
      <a class="brand" href="#/" title="All simulations"><span class="orb"></span></a>
      <div class="ws-title" id="ws-title"></div>
      <div class="stepper" id="stepper"></div>
      <div class="status" id="status"></div>
      <span class="calls" id="calls"></span>
      <div class="seg" id="layout">${[['graph', 'Graph'], ['split', 'Split'], ['work', 'Workbench']].map(([k, l]) => `<button data-l="${k}">${l}</button>`).join('')}</div>
    </header>
    <main class="ws-body" id="ws-body">
      <section class="graph-panel" id="graph-panel">
        <svg id="graph"></svg>
        <div class="graph-empty" id="graph-empty"></div>
        <div class="graph-tools"><span class="chip" id="graph-count"></span></div>
        <div class="legend" id="legend"></div>
        <div id="node-card"></div>
      </section>
      <section class="work" id="work"></section>
    </main>
    <details class="console" id="console"><summary><span>Console</span><span class="dim" id="console-last"></span></summary><div class="lines" id="console-lines"></div></details>
  </div>`;
  $('#stepper').onclick = (e) => {
    const b = e.target.closest('.step');
    if (b && !b.classList.contains('locked')) setTab(b.dataset.k);
  };
  $('#layout').onclick = (e) => {
    const l = e.target.dataset.l;
    if (!l) return;
    S.layout = l;
    renderHead();
    setTimeout(centerGraph, 320);
  };
  $('#work').addEventListener('click', onWorkClick);
  $('#work').addEventListener('input', onWorkInput);
  $('#work').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.dataset.send) {
      e.preventDefault();
      $(`[data-act="${e.target.dataset.send}"]`)?.click();
    }
  });
  for (const row of S.sim.log) addLog(row);
  initGraph();
  updateGraph();
}

function renderHead() {
  const m = S.sim.meta;
  $('#ws-title').textContent = m.name;
  $('#ws-title').title = m.requirement;
  $('#stepper').innerHTML = steps(m).map((s, i) => `<div class="step ${s.done ? 'done' : ''} ${s.live ? 'live' : ''} ${s.locked ? 'locked' : ''} ${S.tab === s.key ? 'active' : ''}" data-k="${s.key}"><span class="n">${s.done ? '✓' : i + 1}</span>${s.label}</div>`).join('');
  const busy = ['created', 'preparing', 'running', 'reporting', 'stopping'].includes(m.status);
  const msg = m.message && m.message !== STATUS_STYLE[m.status]?.[0] ? m.message : '';
  $('#status').innerHTML = `${statusChip(m.status)}${busy ? `<div class="bar"><i style="width:${m.progress || 0}%"></i></div>` : ''}<span class="txt" style="${m.error ? 'color:var(--red)' : ''}" title="${esc(msg)}">${esc(msg)}</span>`;
  $('#calls').textContent = `${m.usage.calls} Claude calls`;
  $('#calls').title = `${m.usage.input_tokens.toLocaleString()} input / ${m.usage.output_tokens.toLocaleString()} output tokens`;
  for (const b of $('#layout').children) b.classList.toggle('on', b.dataset.l === S.layout);
  $('#ws-body').className = `ws-body ${S.layout === 'graph' ? 'l-graph' : S.layout === 'work' ? 'l-work' : ''}`;
}

let renderTimer = null;
function rerender(tab) {
  if (tab && S.tab !== tab) return;
  if (S.tab === 'interact') return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderWork, 200);
}

function renderWork() {
  if (!S.sim) return;
  const w = $('#work');
  w.innerHTML = { graph: graphTab, setup: setupTab, simulation: simTab, report: reportTab, interact: interactTab }[S.tab]();
  if (S.tab === 'simulation') { renderFeeds(); renderSimLive(); }
  if (S.tab === 'interact') { const box = $('.chatbox'); if (box) box.scrollTop = box.scrollHeight; }
}

// ---------- SSE ----------
function connect(id) {
  const es = new EventSource(`/api/sims/${id}/events`);
  S.es = es;
  let dropped = false;
  const on = (type, fn) => es.addEventListener(type, (e) => S.sim && fn(JSON.parse(e.data)));
  es.onerror = () => (dropped = true);
  es.onopen = async () => {
    if (!dropped) return;
    dropped = false;
    S.sim = { ...S.sim, ...(await api(`/sims/${id}`)) };
    updateGraph();
    renderHead();
    renderWork();
  };
  on('meta', onMeta);
  on('log', addLog);
  on('ontology', (o) => { S.sim.ontology = o; updateGraph(); rerender('graph'); });
  on('graph', (g) => { S.sim.graph = g; updateGraph(); rerender('graph'); });
  on('agents', (a) => { S.sim.agents = a; rerender('setup'); });
  on('config', (c) => { S.sim.config = c; rerender('setup'); });
  on('actions', onActions);
  on('report', onReport);
  on('chat', onChatStep);
}

function onMeta(m) {
  const prev = S.sim.meta;
  S.sim.meta = m;
  renderHead();
  const changed = prev.status !== m.status || prev.stage !== m.stage;
  if (changed && S.follow && autoTab(m) !== S.tab) return setTab(autoTab(m), false);
  if (changed) return rerender();
  if (S.tab === 'simulation') return renderSimLive();
  for (const el of document.querySelectorAll('[data-bind="msg"]')) el.textContent = m.message || '';
  for (const el of document.querySelectorAll('[data-bind="bar"]')) el.style.width = `${m.progress || 0}%`;
}

function addLog(row) {
  const lines = $('#console-lines');
  if (!lines) return;
  const t = new Date(row.ts);
  lines.insertAdjacentHTML('beforeend', `<div class="${row.level}">${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}  ${esc(row.msg)}</div>`);
  while (lines.children.length > 300) lines.firstChild.remove();
  lines.scrollTop = lines.scrollHeight;
  $('#console-last').textContent = `— ${row.msg}`;
}

// ---------- graph tab ----------
function typeColor(type) {
  const types = S.sim?.ontology?.entity_types?.map((t) => t.name) || [];
  const i = types.indexOf(type);
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 0;
  for (const c of String(type)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}

function stageState(key) {
  const m = S.sim.meta;
  if (m.status !== 'preparing' && m.status !== 'created' && m.status !== 'failed') return 'done';
  const cur = STAGE_ORDER.indexOf(m.stage);
  const idx = STAGE_ORDER.indexOf(key);
  if (idx < cur) return 'done';
  if (idx === cur) return m.status === 'failed' ? 'failed' : 'live';
  return 'pending';
}

const stageBadge = (st) => (st === 'done' ? '<span class="chip" style="color:var(--green)">Done</span>'
  : st === 'live' ? '<span class="chip" style="color:var(--cyan)"><span class="spinner"></span>Working</span>'
    : st === 'failed' ? '<span class="chip" style="color:var(--red)">Failed</span>' : '<span class="chip dim">Waiting</span>');

function failedCard() {
  const m = S.sim.meta;
  if (m.status !== 'failed') return '';
  return `<div class="card" style="border-color:rgba(251,113,133,.5)"><b style="color:var(--red)">Preparation stopped</b><p class="muted" style="margin:6px 0 12px">${esc(m.error || m.message)}</p><button class="btn" data-act="prepare">Retry preparation</button></div>`;
}

function graphTab() {
  const { meta, ontology, graph } = S.sim;
  const g = graph || { nodes: [], edges: [] };
  const ont = ontology || { entity_types: [], edge_types: [] };
  const st = { ingest: stageState('ingest'), ontology: stageState('ontology'), graph: stageState('graph') };
  const live = st.graph === 'live' || st.ontology === 'live' || st.ingest === 'live';
  return `<div class="stack">
    <div><h2>Knowledge graph</h2><div class="muted">The real actors in your documents and how they relate. Each one becomes an agent.</div></div>
    ${failedCard()}
    <div class="stage ${st.ingest}"><div class="num">01</div><div class="card">
      <div class="stage-head"><b>Read documents</b>${stageBadge(st.ingest)}</div>
      <div class="tags">${(meta.docs || []).map((d) => `<span class="chip">${esc(d)}</span>`).join('')}</div>
    </div></div>
    <div class="stage ${st.ontology}"><div class="num">02</div><div class="card">
      <div class="stage-head"><b>Ontology</b>${stageBadge(st.ontology)}</div>
      ${ont.entity_types.length ? `<div class="label" style="margin-top:8px">Actor types</div>
      <div class="tags">${ont.entity_types.map((t) => `<span class="chip" title="${esc(t.description)}"><span class="dot" style="background:${typeColor(t.name)}"></span>${esc(t.name)}</span>`).join('')}</div>
      <div class="label" style="margin-top:12px">Relationship types</div>
      <div class="tags">${ont.edge_types.map((t) => `<span class="chip mono" style="font-size:11px" title="${esc(t.description)}">${esc(t.name)}</span>`).join('')}</div>
      ${ont.analysis_summary ? `<div class="tip">${esc(ont.analysis_summary)}</div>` : ''}` : '<div class="dim">Claude is reading the material and deciding which kinds of actors matter.</div>'}
    </div></div>
    <div class="stage ${st.graph}"><div class="num">03</div><div class="card">
      <div class="stage-head"><b>Extract actors and relations</b>${stageBadge(st.graph)}</div>
      ${live ? `<div class="bar" style="margin:10px 0"><i data-bind="bar" style="width:${meta.progress}%"></i></div><div class="muted" style="font-size:12.5px" data-bind="msg">${esc(meta.message)}</div>` : ''}
      <div class="stats" style="margin-top:10px">
        <div class="stat"><b>${g.nodes.length}</b><span>entities</span></div>
        <div class="stat"><b>${g.edges.length}</b><span>relations</span></div>
        <div class="stat"><b>${new Set(g.nodes.map((n) => n.type)).size}</b><span>types in use</span></div>
      </div>
    </div></div>
    ${steps(meta)[1].locked ? '' : '<div><button class="btn primary" data-tab="setup">Agent setup →</button></div>'}
  </div>`;
}

// ---------- setup tab ----------
function personaCard(a) {
  return `<div class="persona st-${a.stance}" data-agent="${a.id}">
    <div class="top"><div class="avatar">${esc(initials(a.name))}</div><div class="who"><b>${esc(a.name)}</b><span>@${esc(a.username)}</span></div></div>
    <div class="tags" style="margin:0"><span class="chip st-chip">${a.stance}</span><span class="chip">${esc(a.profession || a.kind)}</span>${a.ref ? '<span class="chip" title="From the source documents">◆ source</span>' : ''}</div>
    <p>${esc(a.bio)}</p>
  </div>`;
}

function hourStrip(on, peak = [], off = []) {
  return `<div class="hours">${Array.from({ length: 24 }, (_, h) => `<i class="${on.includes(h) ? (peak.includes(h) ? 'peak' : 'on') : off.includes(h) ? 'off' : ''}" title="${pad(h)}:00"></i>`).join('')}</div>
  <div class="mono dim" style="display:flex;justify-content:space-between;font-size:10.5px;margin-top:3px"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
}

function setupTab() {
  const { meta, config } = S.sim;
  const agents = S.sim.agents || [];
  const st = { personas: stageState('personas'), config: stageState('config') };
  const f = S.personaFilter;
  const shown = agents.filter((a) => f === 'all' || (f === 'source' ? a.ref : f === 'public' ? !a.ref : a.stance === f));
  const count = (fn) => agents.filter(fn).length;
  const canRun = ['ready', 'simulated', 'reported', 'failed'].includes(meta.status) && !!config;
  const e = estimate(agents.length || meta.settings.agents, S.runRounds);
  const byId = new Map(agents.map((a) => [a.id, a]));
  return `<div class="stack">
    <div><h2>Agent setup</h2><div class="muted">Every agent's persona, stance and online rhythm, plus the simulation clock and the posts that start the conversation.</div></div>
    ${failedCard()}
    <div class="stage ${st.personas}"><div class="num">04</div><div class="card">
      <div class="stage-head"><b>Personas · ${agents.length}/${meta.settings.agents}</b>${stageBadge(st.personas)}</div>
      ${st.personas === 'live' ? `<div class="bar" style="margin:10px 0"><i data-bind="bar" style="width:${meta.progress}%"></i></div><div class="muted" style="font-size:12.5px;margin-bottom:10px" data-bind="msg">${esc(meta.message)}</div>` : ''}
      <div class="toolbar" style="margin:8px 0 12px">
        ${[['all', `All ${agents.length}`], ['source', `From documents ${count((a) => a.ref)}`], ['public', `Public ${count((a) => !a.ref)}`], ...STANCES.map((s) => [s, `${s} ${count((a) => a.stance === s)}`])]
    .map(([k, l]) => `<span class="chip click ${f === k ? 'on' : ''} ${STANCES.includes(k) ? `st-${k}` : ''}" data-pf="${k}">${l}</span>`).join('')}
      </div>
      <div class="personas">${shown.map(personaCard).join('') || '<div class="dim">Personas appear here as Claude writes them.</div>'}</div>
    </div></div>
    <div class="stage ${st.config}"><div class="num">05</div><div class="card">
      <div class="stage-head"><b>Clock and opening moves</b>${stageBadge(st.config)}</div>
      ${config ? `
      <div class="stats" style="margin:10px 0">
        <div class="stat"><b>${config.total_hours}h</b><span>simulated span</span></div>
        <div class="stat"><b>${pad(config.start_hour)}:00</b><span>story breaks${config.timezone ? ` · ${esc(config.timezone)}` : ''}</span></div>
        <div class="stat"><b>${config.initial_posts.length}</b><span>opening posts</span></div>
      </div>
      <div class="label" style="margin:12px 0 6px">Daily rhythm · <span style="color:var(--pink)">peak</span> / <span style="color:var(--violet)">active</span> / quiet</div>
      ${hourStrip(Array.from({ length: 24 }, (_, h) => h).filter((h) => !config.off_peak_hours.includes(h)), config.peak_hours, config.off_peak_hours)}
      <div class="label" style="margin:14px 0 6px">Hot topics</div>
      <div class="tags">${config.hot_topics.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>
      ${config.narrative_direction ? `<div class="tip"><b>Expected direction (a guess, not a result):</b> ${esc(config.narrative_direction)}</div>` : ''}
      <div class="label" style="margin:16px 0 10px">Opening posts</div>
      <div class="timeline">${config.initial_posts.map((p) => {
    const a = byId.get(p.poster_id);
    return `<div class="ev" style="--c:${p.platform === 'twitter' ? 'var(--micro)' : 'var(--forum)'}"><div class="mono dim" style="font-size:11.5px">${p.platform === 'twitter' ? 'Microblog' : 'Forum'} · @${esc(a?.username)}</div>${p.title ? `<b>${esc(p.title)}</b><br>` : ''}<span>${esc(p.content)}</span></div>`;
  }).join('')}</div>` : '<div class="dim">Set after the personas are written.</div>'}
    </div></div>
    <div class="card run-box">
      <div class="stage-head"><b>Run the simulation</b>${['simulated', 'reported'].includes(meta.status) ? '<span class="chip" style="color:var(--amber)">Re-running replaces the current results</span>' : ''}</div>
      <div class="field" style="margin:12px 0 8px"><div class="slider-head"><span class="label">Rounds</span><b id="run-rounds-v">${S.runRounds}</b></div>
      <input type="range" id="run-rounds" min="1" max="100" value="${S.runRounds}"></div>
      <div class="muted" style="font-size:12.5px;margin-bottom:12px" id="run-est">${runEstimate(e)}</div>
      <button class="btn primary" data-act="run" ${canRun ? '' : 'disabled'}>${['simulated', 'reported'].includes(meta.status) ? 'Re-run simulation' : 'Start simulation'}</button>
    </div>
  </div>`;
}

const runEstimate = (e) => `Each round covers ${S.sim.config ? Math.max(S.sim.config.minutes_per_round, Math.ceil((S.sim.config.total_hours * 60) / S.runRounds)) : '?'} simulated minutes. Whole run ≈ ${e.total} Claude calls.`;

// ---------- simulation tab ----------
function simTab() {
  const m = S.sim.meta;
  return `<div class="stack">
    <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:200px"><h2>Simulation</h2><div class="muted">Two platforms run side by side. Claude plays each active agent from their persona, memory and feed.</div></div>
      ${m.status === 'running' ? '<button class="btn danger" data-act="stop">Stop after this round</button>' : ''}
      ${m.status === 'simulated' ? '<button class="btn primary" data-act="report">Generate report →</button>' : ''}
      ${['reporting', 'reported'].includes(m.status) ? '<button class="btn" data-tab="report">Open report →</button>' : ''}
    </div>
    <div class="tiles" id="tiles"></div>
    <div class="card" style="padding:12px 14px"><div class="label" style="margin-bottom:6px">Actions per round · <span style="color:var(--micro)">microblog</span> / <span style="color:var(--forum)">forum</span></div><svg class="chart" id="chart" preserveAspectRatio="none"></svg></div>
    <div class="toolbar"><div class="seg">${[['all', 'All actions'], ['writes', 'Posts and comments']].map(([k, l]) => `<button data-feed="${k}" class="${S.feedMode === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="feeds">
      <div class="feed-col"><div class="label"><span class="dot" style="background:var(--micro)"></span>Microblog</div><div class="feed" id="feed-twitter"></div></div>
      <div class="feed-col"><div class="label"><span class="dot" style="background:var(--forum)"></span>Forum</div><div class="feed" id="feed-reddit"></div></div>
    </div>
  </div>`;
}

function renderSimLive() {
  if (S.tab !== 'simulation' || !$('#tiles')) return;
  const m = S.sim.meta;
  const c = m.counts || {};
  const sim = m.sim || {};
  $('#tiles').innerHTML = `
    <div class="tile"><span class="label">Round</span><b>${sim.round ?? 0}<span class="dim" style="font-size:14px">/${sim.rounds ?? m.settings.rounds}</span></b><small>${esc(sim.clock || '')}</small></div>
    <div class="tile"><span class="label"><span class="dot" style="background:var(--micro)"></span>Microblog</span><b>${c.twitter || 0}</b><small>actions</small></div>
    <div class="tile"><span class="label"><span class="dot" style="background:var(--forum)"></span>Forum</span><b>${c.reddit || 0}</b><small>actions</small></div>
    <div class="tile"><span class="label">Content</span><b>${(c.posts || 0) + (c.comments || 0)}</b><small>${c.posts || 0} posts · ${c.comments || 0} comments</small></div>
    <div class="tile"><span class="label">Claude</span><b>${m.usage.calls}</b><small>calls so far</small></div>`;
  const per = new Map();
  for (const a of S.sim.actions) {
    const r = per.get(a.round) || { twitter: 0, reddit: 0 };
    r[a.platform]++;
    per.set(a.round, r);
  }
  const rounds = Math.max(sim.rounds || m.settings.rounds, ...per.keys(), 1);
  const max = Math.max(1, ...[...per.values()].map((r) => r.twitter + r.reddit));
  const w = 100 / (rounds + 1);
  let bars = '';
  for (const [r, v] of per) {
    const ht = (v.twitter / max) * 66;
    const hr = (v.reddit / max) * 66;
    bars += `<rect x="${r * w + w * 0.12}" y="${70 - ht}" width="${w * 0.76}" height="${ht}" fill="#38bdf8" rx="0.6"/><rect x="${r * w + w * 0.12}" y="${70 - ht - hr}" width="${w * 0.76}" height="${hr}" fill="#fb923c" rx="0.6"/>`;
  }
  $('#chart').setAttribute('viewBox', '0 0 100 70');
  $('#chart').innerHTML = bars;
}

function postCard(a) {
  const ag = S.sim.agents?.[a.agent_id] || { stance: 'neutral', name: a.agent };
  const verb = a.platform === 'twitter' && a.action === 'LIKE_POST' ? 'liked' : a.platform === 'reddit' && a.action === 'LIKE_POST' ? 'upvoted' : VERB[a.action] || a.action;
  let body = '';
  if (WRITES.has(a.action)) body += `<div class="body">${a.title ? `<b>${esc(a.title)}</b>` : ''}${esc(a.content)}</div>`;
  if (a.ref_author) body += `<div class="ref">${a.action === 'CREATE_COMMENT' ? 'on' : ''} @${esc(a.ref_author)}: ${esc(a.ref_content)}</div>`;
  if (a.target) body += `<div class="body muted">@${esc(a.target)}</div>`;
  return `<div class="post st-${ag.stance}">
    <div class="top"><div class="avatar" data-agent="${a.agent_id}" style="cursor:pointer">${esc(initials(ag.name))}</div>
    <div class="meta"><b data-agent="${a.agent_id}" style="cursor:pointer">${esc(ag.name)}</b> <span>@${esc(a.handle)} · ${verb}</span></div>
    <span class="badge ${WRITES.has(a.action) ? 'write' : ''}">${a.action.replace(/_/g, ' ')}</span></div>
    ${body}
    <div class="foot">R${a.round} · Day ${a.day} ${pad(a.hour)}:00${a.post_id ? ` · ${a.new_post_id || a.comment_id || a.post_id}` : ''}</div>
  </div>`;
}

const feedFilter = (a) => S.feedMode === 'all' || WRITES.has(a.action);

function renderFeeds() {
  for (const p of ['twitter', 'reddit']) {
    const el = $(`#feed-${p}`);
    if (!el) continue;
    const items = S.sim.actions.filter((a) => a.platform === p && feedFilter(a)).slice(-150).reverse();
    el.innerHTML = items.map(postCard).join('') || '<div class="dim">Nothing yet.</div>';
  }
}

function onActions(list) {
  const fresh = list.filter((a) => a.action !== 'DO_NOTHING');
  S.sim.actions.push(...fresh);
  if (S.tab !== 'simulation') return;
  for (const p of ['twitter', 'reddit']) {
    const el = $(`#feed-${p}`);
    if (!el) continue;
    const add = fresh.filter((a) => a.platform === p && feedFilter(a));
    if (!add.length) continue;
    if (el.firstElementChild?.classList.contains('dim')) el.innerHTML = '';
    el.insertAdjacentHTML('afterbegin', add.reverse().map(postCard).join(''));
    while (el.children.length > 150) el.lastChild.remove();
  }
  renderSimLive();
}

// ---------- report tab ----------
function reportTab() {
  const { meta, report } = S.sim;
  const outline = report.outline;
  const canGen = ['simulated', 'reported'].includes(meta.status);
  if (!outline && meta.status !== 'reporting') {
    return `<div class="stack"><h2>Prediction report</h2>
      <div class="card run-box"><b>Turn the simulation into a report</b><p class="muted">A report agent plans an outline, interviews a handful of agents, then writes each section by searching the full record of posts, threads and stats. You can watch every tool call.</p>
      <button class="btn primary" data-act="report" ${canGen ? '' : 'disabled'}>Generate report</button>${meta.error ? `<p style="color:var(--red)">${esc(meta.message)}</p>` : ''}</div></div>`;
  }
  const log = report.log;
  const doneCount = report.sections.filter(Boolean).length;
  const total = outline?.sections.length || 0;
  const liveIdx = meta.status === 'reporting' ? [...log].reverse().find((e) => e.kind === 'section_start')?.section : -1;
  const tools = log.filter((e) => e.kind === 'tool_call').length;
  const paper = outline ? `
    <div class="paper">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span class="label">Prediction report</span>
      ${meta.status === 'reported' ? `<span style="display:flex;gap:8px"><a class="btn sm" href="/api/sims/${meta.id}/report.md">Download .md</a><button class="btn sm" data-act="report">Regenerate</button></span>` : ''}</div>
      <h1>${esc(outline.title)}</h1>
      <p class="summary">${esc(outline.summary)}</p>
      ${outline.sections.map((s, i) => `<div class="sec"><h3><span class="n">${pad(i + 1)}</span>${esc(s.title)}${i === liveIdx ? ' <span class="spinner"></span>' : ''}</h3>
        ${report.sections[i] ? `<div class="md">${md(report.sections[i])}</div>` : `<div class="dim" style="font-size:13px">${i === liveIdx ? 'Gathering evidence and writing…' : 'Queued'}</div>`}</div>`).join('')}
    </div>` : '<div class="paper"><span class="spinner"></span> <span class="muted">Planning the outline…</span></div>';
  return `<div class="split2">
    <div>${paper}</div>
    <div class="stack">
      <div class="tiles">
        <div class="tile"><span class="label">Sections</span><b>${doneCount}/${total || '…'}</b></div>
        <div class="tile"><span class="label">Tool calls</span><b>${tools}</b></div>
        <div class="tile"><span class="label">Elapsed</span><b>${Math.round(log.at(-1)?.t || 0)}s</b></div>
      </div>
      <div class="label">Agent workflow</div>
      <div class="flow">${log.map(flowEvent).join('')}</div>
    </div>
  </div>`;
}

function flowEvent(e) {
  const t = `<span class="t">+${e.t}s</span>`;
  const sec = (i) => (Number.isInteger(i) ? `<span class="dim mono">§${i + 1}</span>` : '');
  switch (e.kind) {
    case 'plan_start': return `<div class="ev"><div class="h"><span class="tool plan">PLAN</span>Reading stats and planning the outline${t}</div></div>`;
    case 'plan': return `<div class="ev"><div class="h"><span class="tool plan">OUTLINE</span>${e.outline.sections.length} sections${t}</div><pre>${esc(e.outline.sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n'))}</pre></div>`;
    case 'section_start': return `<div class="ev" style="border-color:rgba(139,92,246,.4)"><div class="h"><span class="tool plan">SECTION ${e.section + 1}</span>${esc(e.title)}${t}</div></div>`;
    case 'tool_call': {
      const inp = e.input || {};
      const brief = inp.pattern ? `/${inp.pattern}/ ${inp.path || inp.glob || ''}` : inp.file_path ? inp.file_path.split('/').pop() : inp.questions ? `${(inp.agent_ids || []).length} agents · ${inp.questions.length} questions` : JSON.stringify(inp).slice(0, 120);
      return `<div class="ev"><div class="h"><span class="tool ${e.tool === 'interview_agents' ? 'interview' : ''}">${esc(e.tool)}</span><span class="mono" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(brief)}</span>${sec(e.section)}${t}</div></div>`;
    }
    case 'tool_result': return `<div class="ev"><details><summary>Result${e.tool ? ` · ${esc(e.tool)}` : ''}</summary><pre>${esc(e.preview)}</pre></details></div>`;
    case 'thought': return `<div class="ev"><div class="h dim">💭 ${esc(e.text).slice(0, 220)}${sec(e.section)}${t}</div></div>`;
    case 'section_done': return `<div class="ev"><div class="h" style="color:var(--green)">✓ ${esc(e.title)}${t}</div></div>`;
    case 'done': return `<div class="ev"><div class="h" style="color:var(--green)">Report complete${t}</div></div>`;
    case 'error': return `<div class="ev"><div class="h" style="color:var(--red)">Error: ${esc(e.message)}${t}</div></div>`;
    default: return '';
  }
}

function onReport(e) {
  const r = S.sim.report;
  if (e.kind === 'plan_start') {
    r.log = [];
    r.sections = [];
    r.outline = null;
  }
  r.log.push(e);
  if (e.kind === 'plan') r.outline = e.outline;
  if (e.kind === 'section_done') r.sections[e.section] = e.markdown;
  rerender('report');
}

// ---------- interact tab ----------
function interactTab() {
  const m = S.sim.meta;
  if (!['simulated', 'reporting', 'reported'].includes(m.status)) return '<div class="stack"><h2>Interact</h2><div class="card dim">Available once the simulation has run.</div></div>';
  const t = S.interactTab;
  const seg = `<div class="seg" style="align-self:flex-start">${[['report', 'Ask the report agent'], ['agent', 'Interview an agent'], ['survey', 'Survey many agents']].map(([k, l]) => `<button data-it="${k}" class="${t === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="stack"><div><h2>Interact</h2><div class="muted">Question the simulated world after the fact.</div></div>${seg}${t === 'report' ? reportChat() : t === 'agent' ? agentChat() : survey()}</div>`;
}

const bubble = (msg, who) => (msg.role === 'user'
  ? `<div class="msg user">${esc(msg.content)}</div>`
  : `<div class="msg bot"><div class="who">${esc(who)}</div><div class="md">${md(msg.content)}</div></div>`);
const typing = () => (S.pending ? `<div class="msg bot"><span class="spinner"></span> <span class="muted" id="chat-steps">${esc(S.chatSteps.at(-1) || 'Thinking…')}</span></div>` : '');
const composer = (key, placeholder) => `<div class="composer"><textarea rows="2" data-draft="${key}" data-send="${key}" placeholder="${esc(placeholder)}">${esc(S.drafts[key] || '')}</textarea><button class="btn primary" data-act="${key}" ${S.pending ? 'disabled' : ''}>Send</button></div>`;

function reportChat() {
  const msgs = S.chats.report;
  return `<div class="card stack">
    <div class="muted" style="font-size:13px">The report agent searches the full record (every post, thread, stat and interview) before answering.</div>
    <div class="chatbox">${msgs.map((x) => bubble(x, 'Report agent')).join('') || '<div class="dim">Try: “Which argument changed the most minds?” or “What would make critics come around?”</div>'}${typing()}</div>
    ${composer('send-report', 'Ask about the simulation…')}
  </div>`;
}

function agentChat() {
  const agents = S.sim.agents || [];
  const sorted = [...agents].sort((a, b) => b.influence - a.influence);
  const id = S.interviewAgent ?? sorted[0]?.id;
  S.interviewAgent = id;
  const a = agents[id];
  const msgs = S.chats.agent[id] || [];
  return `<div class="card stack">
    <select id="agent-select">${sorted.map((x) => `<option value="${x.id}" ${x.id === id ? 'selected' : ''}>@${esc(x.username)} — ${esc(x.name)} (${x.stance})</option>`).join('')}</select>
    ${a ? `<div class="persona st-${a.stance}" data-agent="${a.id}" style="cursor:pointer"><div class="top"><div class="avatar">${esc(initials(a.name))}</div><div class="who"><b>${esc(a.name)}</b><span>@${esc(a.username)} · ${esc(a.profession || a.kind)}</span></div></div><p>${esc(a.bio)}</p></div>` : ''}
    <div class="chatbox">${msgs.map((x) => bubble(x, `@${a?.username}`)).join('') || '<div class="dim">They answer in character, from their persona and everything they did in the simulation.</div>'}${typing()}</div>
    ${composer('send-agent', `Ask @${a?.username || 'agent'} something…`)}
  </div>`;
}

function survey() {
  const agents = S.sim.agents || [];
  const f = S.survey.filter;
  const shown = agents.filter((a) => f === 'all' || a.stance === f);
  return `<div class="card stack">
    <div class="toolbar">${['all', ...STANCES].map((k) => `<span class="chip click ${f === k ? 'on' : ''} ${k !== 'all' ? `st-${k}` : ''}" data-sf="${k}">${k}</span>`).join('')}
      <span class="grow" style="flex:1"></span><button class="btn sm" data-act="pick-all">Select shown</button><button class="btn sm" data-act="pick-none">Clear</button><span class="mono dim">${S.survey.picked.size} picked</span></div>
    <div class="pick-grid">${shown.map((a) => `<div class="pick st-${a.stance} ${S.survey.picked.has(a.id) ? 'on' : ''}" data-pick="${a.id}"><div class="avatar">${esc(initials(a.name))}</div><span>@${esc(a.username)}</span></div>`).join('')}</div>
    ${composer('send-survey', 'One question for everyone picked…')}
    ${S.pending ? '<div><span class="spinner"></span> <span class="muted">Interviewing…</span></div>' : ''}
    <div class="answers">${S.survey.results.map((r) => `<div class="card st-${r.stance}" style="padding:14px"><div class="top" style="display:flex;gap:10px;align-items:center;margin-bottom:8px"><div class="avatar">${esc(initials(r.name))}</div><div><b>${esc(r.name)}</b><div class="mono dim" style="font-size:11.5px">@${esc(r.handle)} · ${r.stance}</div></div></div><div class="md">${md(r.answer)}</div></div>`).join('')}</div>
  </div>`;
}

function onChatStep(ev) {
  if (!S.pending) return;
  if (ev.kind === 'tool_call') S.chatSteps.push(`${ev.tool} ${ev.input?.pattern || ev.input?.file_path?.split('/').pop() || ''}`);
  const el = $('#chat-steps');
  if (el) el.textContent = S.chatSteps.at(-1) || 'Thinking…';
}

async function sendChat(kind) {
  const key = `send-${kind}`;
  const text = (S.drafts[key] || '').trim();
  if (!text || S.pending) return;
  const id = S.sim.meta.id;
  S.drafts[key] = '';
  S.pending = true;
  S.chatSteps = [];
  try {
    if (kind === 'report') {
      const hist = S.chats.report;
      hist.push({ role: 'user', content: text });
      renderWork();
      const r = await api(`/sims/${id}/chat`, { body: { message: text, history: hist.slice(0, -1) } });
      hist.push({ role: 'assistant', content: r.answer });
    } else if (kind === 'agent') {
      const aid = S.interviewAgent;
      const hist = (S.chats.agent[aid] ||= []);
      hist.push({ role: 'user', content: text });
      renderWork();
      const r = await api(`/sims/${id}/interview`, { body: { agent_ids: [aid], question: text, history: hist.slice(0, -1) } });
      hist.push({ role: 'assistant', content: r.answers[0]?.answer || '(no answer)' });
    } else {
      if (!S.survey.picked.size) throw new Error('Pick at least one agent.');
      renderWork();
      const r = await api(`/sims/${id}/interview`, { body: { agent_ids: [...S.survey.picked], question: text } });
      S.survey.results = r.answers;
    }
  } catch (e) {
    toast(e.message);
    S.drafts[key] = text;
  }
  S.pending = false;
  if (S.sim?.meta.id === id && S.tab === 'interact') renderWork();
}

// ---------- persona modal ----------
function openPersona(id) {
  const a = S.sim.agents?.[id];
  if (!a) return;
  const canTalk = ['simulated', 'reporting', 'reported'].includes(S.sim.meta.status);
  const did = S.sim.actions.filter((x) => x.agent_id === a.id);
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal card st-${a.stance}">
    <div style="display:flex;gap:14px;align-items:center"><div class="avatar" style="width:52px;height:52px;font-size:18px">${esc(initials(a.name))}</div>
      <div style="flex:1;min-width:0"><div style="font-size:19px;font-weight:600">${esc(a.name)}</div><div class="mono dim">@${esc(a.username)} · ${esc(a.kind)} · ${esc(a.profession)}</div></div>
      <button class="btn sm" data-close>Close</button></div>
    <div class="tags" style="margin:14px 0"><span class="chip st-chip">${a.stance}</span><span class="chip">mood ${a.sentiment.toFixed(1)}</span>${a.age ? `<span class="chip">${a.age}</span>` : ''}${a.gender ? `<span class="chip">${esc(a.gender)}</span>` : ''}${a.mbti ? `<span class="chip">${esc(a.mbti)}</span>` : ''}${a.country ? `<span class="chip">${esc(a.country)}</span>` : ''}${a.ref ? `<span class="chip">◆ ${esc(a.source_type)} from the documents</span>` : '<span class="chip">member of the public</span>'}</div>
    <p style="font-style:italic;margin:0 0 12px">${esc(a.bio)}</p>
    <p class="muted" style="white-space:pre-wrap">${esc(a.persona)}</p>
    <div class="tags">${a.interests.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    <div class="stats" style="margin:16px 0">
      <div class="stat"><b>${Math.round(a.activity * 100)}%</b><span>activity</span></div>
      <div class="stat"><b>${a.influence.toFixed(1)}</b><span>influence</span></div>
      <div class="stat"><b>${did.length}</b><span>actions in sim</span></div>
    </div>
    <div class="label" style="margin-bottom:6px">Online hours</div>${hourStrip(a.active_hours)}
    ${canTalk ? '<button class="btn primary" style="margin-top:16px" data-interview>Interview this agent</button>' : ''}
  </div>`;
  bg.onclick = (e) => {
    if (e.target === bg || e.target.dataset.close !== undefined) bg.remove();
    if (e.target.dataset.interview !== undefined) {
      bg.remove();
      S.interviewAgent = a.id;
      S.interactTab = 'agent';
      setTab('interact');
    }
  };
  document.body.appendChild(bg);
}

// ---------- workbench events ----------
async function post(path, body) {
  try {
    const m = await api(`/sims/${S.sim.meta.id}/${path}`, { body: body || {} });
    onMeta(m);
  } catch (e) {
    toast(e.message);
  }
}

function onWorkClick(e) {
  const t = e.target.closest('[data-act],[data-tab],[data-pf],[data-feed],[data-it],[data-sf],[data-pick],[data-agent]');
  if (!t) return;
  const d = t.dataset;
  if (d.tab) return setTab(d.tab);
  if (d.pf) { S.personaFilter = d.pf; return renderWork(); }
  if (d.feed) { S.feedMode = d.feed; return renderWork(); }
  if (d.it) { S.interactTab = d.it; return renderWork(); }
  if (d.sf) { S.survey.filter = d.sf; return renderWork(); }
  if (d.pick) {
    const id = Number(d.pick);
    S.survey.picked.has(id) ? S.survey.picked.delete(id) : S.survey.picked.add(id);
    return renderWork();
  }
  if (d.act === 'prepare') return post('prepare');
  if (d.act === 'run') {
    if (['simulated', 'reported'].includes(S.sim.meta.status) && !confirm('Re-running replaces the current simulation and report. Continue?')) return;
    S.sim.actions = [];
    S.sim.report = { outline: null, sections: [], log: [] };
    S.follow = true;
    return post('run', { rounds: S.runRounds });
  }
  if (d.act === 'stop') return post('stop');
  if (d.act === 'report') { S.follow = true; return post('report'); }
  if (d.act === 'pick-all') { for (const a of S.sim.agents || []) if (S.survey.filter === 'all' || a.stance === S.survey.filter) S.survey.picked.add(a.id); return renderWork(); }
  if (d.act === 'pick-none') { S.survey.picked.clear(); return renderWork(); }
  if (d.act?.startsWith('send-')) return sendChat(d.act.slice(5));
  if (d.agent !== undefined) return openPersona(Number(d.agent));
}

function onWorkInput(e) {
  const t = e.target;
  if (t.dataset.draft) S.drafts[t.dataset.draft] = t.value;
  if (t.id === 'run-rounds') {
    S.runRounds = Number(t.value);
    $('#run-rounds-v').textContent = S.runRounds;
    $('#run-est').textContent = runEstimate(estimate(S.sim.agents?.length || S.sim.meta.settings.agents, S.runRounds));
  }
  if (t.id === 'agent-select') { S.interviewAgent = Number(t.value); renderWork(); }
}

// =====================================================================
// Graph (d3 force layout, merges updates so the graph grows in place)
// =====================================================================
const G = { svg: null, nodes: [], links: [] };

function initGraph() {
  const svg = d3.select('#graph');
  svg.selectAll('*').remove();
  const root = svg.append('g');
  G.svg = svg;
  G.root = root;
  G.linkG = root.append('g');
  G.nodeG = root.append('g');
  G.nodes = [];
  G.links = [];
  G.zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', (e) => root.attr('transform', e.transform));
  svg.call(G.zoom).on('dblclick.zoom', null);
  svg.on('click', (e) => { if (e.target === svg.node()) selectNode(null); });
  G.sim = d3.forceSimulation()
    .force('link', d3.forceLink().id((d) => d.id).distance(80).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-240))
    .force('collide', d3.forceCollide().radius((d) => d.r + 10))
    .force('x', d3.forceX().strength(0.05))
    .force('y', d3.forceY().strength(0.05))
    .on('tick', () => {
      G.linkSel?.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
      G.nodeSel?.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });
  centerGraph();
}

function centerGraph() {
  const el = $('#graph');
  if (!el || !G.sim) return;
  const { width, height } = el.getBoundingClientRect();
  G.sim.force('x').x(width / 2);
  G.sim.force('y').y(height / 2);
  G.sim.alpha(0.3).restart();
}

function updateGraph() {
  if (!G.svg) return;
  const graph = S.sim.graph || { nodes: [], edges: [] };
  $('#graph-empty').innerHTML = graph.nodes.length ? '' : `<div><div class="orb" style="margin:0 auto 14px;width:40px;height:40px"></div>${['preparing', 'created'].includes(S.sim.meta.status) ? 'The knowledge graph appears here as Claude reads your documents.' : 'No graph.'}</div>`;
  $('#graph-count').textContent = `${graph.nodes.length} entities · ${graph.edges.length} relations`;
  const deg = new Map();
  for (const e of graph.edges) for (const k of [e.source, e.target]) deg.set(k, (deg.get(k) || 0) + 1);
  const old = new Map(G.nodes.map((n) => [n.id, n]));
  const { width, height } = $('#graph').getBoundingClientRect();
  G.nodes = graph.nodes.map((n) => Object.assign(old.get(n.id) || { x: width / 2 + (Math.random() - 0.5) * 160, y: height / 2 + (Math.random() - 0.5) * 160 }, n, { r: 6 + Math.sqrt(deg.get(n.id) || 0) * 2.6 }));
  G.links = graph.edges.map((e) => ({ ...e }));

  G.linkSel = G.linkG.selectAll('line').data(G.links, (d) => d.id).join('line')
    .attr('stroke', 'rgba(255,255,255,0.16)').attr('stroke-width', 1.2);
  G.linkSel.selectAll('title').data((d) => [d]).join('title').text((d) => `${d.type}: ${d.fact}`);
  G.nodeSel = G.nodeG.selectAll('g.node').data(G.nodes, (d) => d.id).join((enter) => {
    const g = enter.append('g').attr('class', 'node').style('cursor', 'pointer');
    g.append('circle');
    g.append('text').attr('dy', '0.35em').attr('font-size', 10.5).attr('fill', 'rgba(236,239,250,0.82)').attr('font-family', 'Sora, sans-serif').style('pointer-events', 'none');
    g.on('click', (e, d) => { e.stopPropagation(); selectNode(d.id); });
    g.call(d3.drag()
      .on('start', (e, d) => { if (!e.active) G.sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) G.sim.alphaTarget(0); d.fx = null; d.fy = null; }));
    return g;
  });
  G.nodeSel.select('circle').attr('r', (d) => d.r).attr('fill', (d) => typeColor(d.type)).attr('stroke', '#0b0d18').attr('stroke-width', 2);
  G.nodeSel.select('text').attr('x', (d) => d.r + 4).text((d) => (d.name.length > 18 ? `${d.name.slice(0, 17)}…` : d.name));

  G.sim.nodes(G.nodes);
  G.sim.force('link').links(G.links);
  G.sim.alpha(old.size ? 0.35 : 1).restart();

  const used = [...new Set(graph.nodes.map((n) => n.type))];
  $('#legend').innerHTML = used.map((t) => `<span class="chip"><span class="dot" style="background:${typeColor(t)}"></span>${esc(t)}</span>`).join('');
  highlight();
}

function selectNode(id) {
  S.selected = id;
  highlight();
  const card = $('#node-card');
  if (id == null) { card.innerHTML = ''; return; }
  const g = S.sim.graph;
  const n = g.nodes.find((x) => x.id === id);
  const name = new Map(g.nodes.map((x) => [x.id, x.name]));
  const rels = g.edges.filter((e) => e.source === id || e.target === id || e.source?.id === id || e.target?.id === id);
  const agent = (S.sim.agents || []).find((a) => a.ref === id);
  const sid = (v) => (typeof v === 'object' ? v.id : v);
  card.innerHTML = `<div class="card node-card">
    <span class="close" data-x>✕</span>
    <span class="chip"><span class="dot" style="background:${typeColor(n.type)}"></span>${esc(n.type)}</span>
    <h4>${esc(n.name)}</h4>
    <div class="muted" style="font-size:13px">${esc(n.summary)}</div>
    ${Object.keys(n.attributes || {}).length ? `<div class="tags">${Object.entries(n.attributes).map(([k, v]) => `<span class="chip mono" style="font-size:11px">${esc(k)}: ${esc(v)}</span>`).join('')}</div>` : ''}
    ${agent ? `<div class="persona st-${agent.stance}" data-agent="${agent.id}" style="margin-top:12px"><div class="top"><div class="avatar">${esc(initials(agent.name))}</div><div class="who"><b>Agent @${esc(agent.username)}</b><span>${agent.stance} · open persona</span></div></div></div>` : ''}
    <div class="label" style="margin:14px 0 4px">${rels.length} relations</div>
    ${rels.map((e) => `<div class="rel"><b>${esc(name.get(sid(e.source)))}</b> <span class="mono" style="font-size:10.5px">${esc(e.type)}</span> <b>${esc(name.get(sid(e.target)))}</b><br>${esc(e.fact)}</div>`).join('')}
  </div>`;
  card.onclick = (e) => {
    if (e.target.dataset.x !== undefined) selectNode(null);
    const p = e.target.closest('[data-agent]');
    if (p) openPersona(Number(p.dataset.agent));
  };
}

function highlight() {
  const id = S.selected;
  if (!G.nodeSel) return;
  const near = new Set([id]);
  if (id != null) for (const l of G.links) {
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    if (s === id) near.add(t);
    if (t === id) near.add(s);
  }
  G.nodeSel.attr('opacity', (d) => (id == null || near.has(d.id) ? 1 : 0.2));
  G.nodeSel.select('circle').attr('stroke', (d) => (d.id === id ? '#fff' : '#0b0d18'));
  G.linkSel.attr('stroke', (l) => (id != null && ((l.source.id ?? l.source) === id || (l.target.id ?? l.target) === id) ? 'rgba(34,211,238,0.8)' : 'rgba(255,255,255,0.16)'))
    .attr('opacity', (l) => (id == null || (l.source.id ?? l.source) === id || (l.target.id ?? l.target) === id ? 1 : 0.15));
}

route();

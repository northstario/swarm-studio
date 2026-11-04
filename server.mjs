// Swarm Studio: local swarm-simulation app. Claude (via `claude -p`) plays every role.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { authStatus, MOCK } from './lib/claude.mjs';
import { prepare } from './lib/prepare.mjs';
import { chat, generateReport, interview, writeEvidence } from './lib/report.mjs';
import { simulate } from './lib/simulate.mjs';
import { DATA_DIR, forgetCtx, getCtx, listSims, pingAll, readJSON, readJSONL, ROOT, simDir, subscribe, writeJSON } from './lib/store.mjs';

const PORT = Number(process.env.PORT || 4321);
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 120 * 1024 * 1024) throw new HttpError(413, 'Upload too large (120 MB max)');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const clampInt = (v, lo, hi, d) => {
  const x = Math.round(Number(v));
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

// Run one long task per simulation at a time.
function launch(ctx, task) {
  if (ctx.busy) throw new HttpError(409, 'This simulation is busy with another step.');
  ctx.busy = true;
  task()
    .catch((e) => {
      ctx.log(e.message, 'error');
      ctx.set({ error: e.message, message: e.message });
    })
    .finally(() => (ctx.busy = false));
}

async function fullRun(ctx) {
  if (!(await prepare(ctx)) || !ctx.meta.settings.auto) return;
  await simulate(ctx, { rounds: ctx.meta.settings.rounds });
  if (ctx.meta.status === 'simulated') await generateReport(ctx);
}

function snapshot(id) {
  const meta = readJSON(id, 'meta.json');
  if (!meta) throw new HttpError(404, 'No such simulation');
  const sectionsDir = simDir(id, 'report', 'sections');
  const sections = fs.existsSync(sectionsDir) ? fs.readdirSync(sectionsDir).sort().map((f) => fs.readFileSync(path.join(sectionsDir, f), 'utf8')) : [];
  return {
    meta,
    ontology: readJSON(id, 'ontology.json'),
    graph: readJSON(id, 'graph.json'),
    agents: readJSON(id, 'agents.json'),
    config: readJSON(id, 'config.json'),
    actions: readJSONL(id, 'actions.jsonl').filter((a) => a.action !== 'DO_NOTHING').slice(-1200),
    log: readJSONL(id, 'console.jsonl').slice(-200),
    report: { outline: readJSON(id, 'report/outline.json'), sections, log: readJSONL(id, 'report/log.jsonl').slice(-400) },
  };
}

function createSim(body) {
  const requirement = String(body.requirement || '').trim();
  const files = Array.isArray(body.files) ? body.files : [];
  const text = String(body.text || '').trim();
  if (!requirement) throw new HttpError(400, 'Describe what you want to predict.');
  if (!files.length && !text) throw new HttpError(400, 'Add at least one document or paste some text.');
  const id = `sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const docs = simDir(id, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const names = [];
  for (const f of files) {
    const name = path.basename(String(f.name || 'doc.txt')).replace(/[^\w.\- ]+/g, '_');
    if (!/\.(pdf|md|markdown|txt)$/i.test(name)) throw new HttpError(400, `${name}: only PDF, Markdown and text files are supported.`);
    fs.writeFileSync(path.join(docs, name), Buffer.from(String(f.data || ''), 'base64'));
    names.push(name);
  }
  if (text) {
    fs.writeFileSync(path.join(docs, 'pasted-text.txt'), text);
    names.push('pasted-text.txt');
  }
  writeJSON(id, 'meta.json', {
    id,
    name: String(body.name || '').trim() || requirement.slice(0, 70),
    requirement,
    created_at: new Date().toISOString(),
    status: 'created', stage: 'created', progress: 0, message: 'Queued', error: null,
    settings: { agents: clampInt(body.agents, 10, 300, 150), rounds: clampInt(body.rounds, 1, 100, 30), auto: !!body.auto },
    counts: {}, usage: { calls: 0, input_tokens: 0, output_tokens: 0 }, docs: names,
  });
  const ctx = getCtx(id);
  launch(ctx, () => fullRun(ctx));
  return ctx.meta;
}

// A restart kills in-flight work; leave each sim in a state the UI can resume from.
for (const meta of listSims()) {
  const stale = { preparing: 'failed', created: 'failed', running: 'simulated', reporting: 'simulated', stopping: 'simulated' }[meta.status];
  if (!stale) continue;
  if (stale === 'simulated' && !fs.existsSync(simDir(meta.id, 'world.json'))) continue;
  if (meta.status === 'running' || meta.status === 'stopping') writeEvidence(meta.id);
  writeJSON(meta.id, 'meta.json', { ...meta, status: stale, stage: stale, message: 'Interrupted by a server restart', error: stale === 'failed' ? 'interrupted' : null });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') {
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const [, a, id, action] = parts;
  const m = req.method;
  if (a === 'health') return send(res, 200, { ok: true, mock: MOCK, data: DATA_DIR });
  if (a === 'auth') return send(res, 200, await authStatus());
  if (a !== 'sims') throw new HttpError(404, 'Unknown endpoint');
  if (!id) {
    if (m === 'GET') return send(res, 200, listSims());
    if (m === 'POST') return send(res, 201, createSim(await readBody(req)));
  }

  if (!readJSON(id, 'meta.json')) throw new HttpError(404, 'No such simulation');
  const ctx = getCtx(id);

  if (!action) {
    if (m === 'GET') return send(res, 200, snapshot(id));
    if (m === 'DELETE') {
      if (ctx.busy) throw new HttpError(409, 'Stop it before deleting.');
      forgetCtx(id);
      fs.rmSync(simDir(id), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
  }
  if (action === 'events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    subscribe(id, res);
    return;
  }
  if (action === 'report.md' && m === 'GET') {
    const p = simDir(id, 'report', 'report.md');
    if (!fs.existsSync(p)) throw new HttpError(404, 'No report yet');
    res.writeHead(200, { 'content-type': TYPES['.md'], 'content-disposition': `attachment; filename="${id}-report.md"` });
    fs.createReadStream(p).pipe(res);
    return;
  }
  if (m !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await readBody(req);
  const status = ctx.meta.status;

  switch (action) {
    case 'prepare':
      launch(ctx, () => prepare(ctx));
      return send(res, 202, ctx.meta);
    case 'run': {
      if (!['ready', 'simulated', 'reported', 'failed'].includes(status) || !readJSON(id, 'config.json')) throw new HttpError(409, 'Prepare the simulation first.');
      const rounds = clampInt(body.rounds, 1, 100, ctx.meta.settings.rounds);
      launch(ctx, () => simulate(ctx, { rounds }));
      return send(res, 202, ctx.meta);
    }
    case 'stop':
      if (status === 'running') {
        ctx.stopRequested = true;
        ctx.set({ status: 'stopping', message: 'Stopping after this round' });
      }
      return send(res, 200, ctx.meta);
    case 'report':
      if (!['simulated', 'reported'].includes(status)) throw new HttpError(409, 'Run the simulation first.');
      launch(ctx, () => generateReport(ctx));
      return send(res, 202, ctx.meta);
    case 'chat': {
      if (!['simulated', 'reported'].includes(status)) throw new HttpError(409, 'Run the simulation first.');
      const answer = await chat(ctx, { message: String(body.message || ''), history: body.history || [] });
      ctx.save();
      return send(res, 200, { answer });
    }
    case 'interview': {
      if (!['simulated', 'reported'].includes(status)) throw new HttpError(409, 'Run the simulation first.');
      const answers = await interview(ctx, body.agent_ids || [], String(body.question || ''), body.history || []);
      ctx.save();
      return send(res, 200, { answers });
    }
    default:
      throw new HttpError(404, 'Unknown action');
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) return res.end();
    send(res, e.status || 500, { error: e.message });
  });
});
server.requestTimeout = 15 * 60 * 1000;
setInterval(pingAll, 25000).unref();
server.listen(PORT, '127.0.0.1', () => console.log(`Swarm Studio on http://localhost:${PORT}${MOCK ? ' (mock Claude)' : ''}`));

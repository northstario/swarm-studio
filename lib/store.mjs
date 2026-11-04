// Per-simulation files under data/<id>/ plus the live event hub (SSE fan-out).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.SWARM_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const simDir = (id, ...parts) => path.join(DATA_DIR, id, ...parts);

export function readJSON(id, file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(simDir(id, file), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(id, file, obj) {
  const p = simDir(id, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(obj, null, 1));
  fs.renameSync(`${p}.tmp`, p);
}

export function writeText(id, file, text) {
  const p = simDir(id, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

export function appendJSONL(id, file, rows) {
  if (!rows.length) return;
  fs.appendFileSync(simDir(id, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function readJSONL(id, file) {
  try {
    return fs.readFileSync(simDir(id, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function listSims() {
  return fs.readdirSync(DATA_DIR)
    .map((id) => readJSON(id, 'meta.json'))
    .filter(Boolean)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// --- live events ---
const clients = new Map(); // sim id -> Set<http.ServerResponse>

export function subscribe(id, res) {
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(res);
  res.on('close', () => clients.get(id)?.delete(res));
}

export function pingAll() {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}

export function emit(id, type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients.get(id) || []) res.write(msg);
}

// --- per-simulation context handed to every stage ---
const contexts = new Map();

export function getCtx(id) {
  if (contexts.has(id)) return contexts.get(id);
  const meta = readJSON(id, 'meta.json');
  if (!meta) return null;
  const ctx = {
    id,
    meta,
    usage: meta.usage,
    stopRequested: false,
    emit: (type, data) => emit(id, type, data),
    save() {
      writeJSON(id, 'meta.json', meta);
      emit(id, 'meta', meta);
    },
    set(fields) {
      Object.assign(meta, fields);
      this.save();
    },
    log(msg, level = 'info') {
      const row = { ts: new Date().toISOString(), level, msg };
      appendJSONL(id, 'console.jsonl', [row]);
      emit(id, 'log', row);
    },
  };
  contexts.set(id, ctx);
  return ctx;
}

export function forgetCtx(id) {
  contexts.delete(id);
}

// Runs Claude through the local Claude Code CLI (`claude -p`), so every call uses the
// user's Claude subscription login instead of a pay-per-token API key.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MOCK = process.env.SWARM_LLM === 'mock';
const MOCK_DELAY = Number(process.env.SWARM_MOCK_DELAY || 120);
const MODELS = {
  crowd: process.env.SWARM_CROWD_MODEL || 'haiku',
  brain: process.env.SWARM_BRAIN_MODEL || 'sonnet',
};
const PARALLEL = Number(process.env.SWARM_PARALLEL || 6);
const CLAUDE = process.env.SWARM_CLAUDE_BIN || 'claude';
// Plain calls run from an empty folder so no project CLAUDE.md gets pulled in.
const NEUTRAL_DIR = path.join(tmpdir(), 'swarm-studio-cwd');
mkdirSync(NEUTRAL_DIR, { recursive: true });

let running = 0;
const waiting = [];
async function withSlot(fn) {
  while (running >= PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// Drop host-session variables (desktop app proxy, API keys) so the child CLI
// authenticates with its own subscription login.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE_CODE_|ANTHROPIC_)/.test(k) || k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  return env;
}

function baseArgs(tier, system) {
  return [
    '-p', '--model', MODELS[tier], '--system-prompt', system,
    '--setting-sources', 'project', '--strict-mcp-config',
    '--disable-slash-commands', '--no-session-persistence',
  ];
}

function spawnClaude(args, input, { cwd = NEUTRAL_DIR, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd, env: cleanEnv() });
    let out = '';
    let err = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`could not start '${CLAUDE}': ${e.message}`)));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

function track(ctx, usage = {}) {
  ctx.usage.calls++;
  ctx.usage.input_tokens += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  ctx.usage.output_tokens += usage.output_tokens || 0;
}

function lastResult(out) {
  const lines = out.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(lines[i]);
      if (m.type === 'result') return m;
    } catch {}
  }
  return null;
}

export function extractJSON(text) {
  const t = text.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.search(/[{[]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start < 0 || end <= start) throw new Error('no JSON found');
  return JSON.parse(t.slice(start, end + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One-shot call that must return JSON. `mock` supplies the reply in SWARM_LLM=mock mode.
export async function ask(ctx, { tier = 'crowd', system, prompt, mock }) {
  if (MOCK) {
    track(ctx);
    await sleep(MOCK_DELAY);
    return mock();
  }
  let input = prompt;
  for (let attempt = 1; ; attempt++) {
    const { out, err } = await withSlot(() =>
      spawnClaude([...baseArgs(tier, system), '--tools', '', '--output-format', 'json'], input));
    const res = lastResult(out);
    if (!res) throw new Error(`claude gave no result: ${(err || out).slice(-400)}`);
    track(ctx, res.usage);
    if (res.is_error) throw new Error(`claude: ${res.result || res.subtype}`);
    try {
      return extractJSON(res.result);
    } catch {
      if (attempt >= 2) throw new Error(`claude returned non-JSON: ${String(res.result).slice(0, 200)}`);
      input = `${prompt}\n\nYour previous reply was not valid JSON. Reply with only the JSON.`;
    }
  }
}

export async function authStatus() {
  if (MOCK) return { loggedIn: true, mock: true };
  try {
    const { out } = await spawnClaude(['auth', 'status'], '');
    return JSON.parse(out);
  } catch {
    return { loggedIn: false };
  }
}

function toText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('\n');
  return '';
}

// Tool-using agent (Read/Grep/Glob inside `cwd`) that streams its steps to onEvent
// and resolves with its final text.
export async function runAgent(ctx, { system, prompt, cwd, onEvent = () => {}, mock }) {
  if (MOCK) {
    track(ctx);
    onEvent({ kind: 'tool_call', tool: 'Grep', input: { pattern: 'mock' } });
    await sleep(MOCK_DELAY);
    onEvent({ kind: 'tool_result', preview: 'mock evidence line' });
    return mock();
  }
  const args = [
    ...baseArgs('brain', system),
    '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
    '--output-format', 'stream-json', '--verbose',
  ];
  const onLine = (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const content = m.message?.content || [];
    if (m.type === 'assistant') {
      for (const c of content) {
        if (c.type === 'tool_use') onEvent({ kind: 'tool_call', tool: c.name, input: c.input });
        else if (c.type === 'text' && c.text.trim()) onEvent({ kind: 'thought', text: c.text.slice(0, 400) });
      }
    } else if (m.type === 'user') {
      for (const c of content) {
        if (c.type === 'tool_result') onEvent({ kind: 'tool_result', preview: toText(c.content).slice(0, 600) });
      }
    }
  };
  const { out, err } = await withSlot(() => spawnClaude(args, prompt, { cwd, onLine }));
  const res = lastResult(out);
  if (!res) throw new Error(`claude agent gave no result: ${(err || out).slice(-400)}`);
  track(ctx, res.usage);
  if (res.is_error) throw new Error(`claude: ${res.result || res.subtype}`);
  return String(res.result || '').trim();
}

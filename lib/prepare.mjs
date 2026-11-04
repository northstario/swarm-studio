// Stage 1-2 of a simulation: documents -> ontology -> knowledge graph -> agent personas -> clock + opening posts.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ask } from './claude.mjs';
import { simDir, writeJSON, writeText } from './store.mjs';

const run = promisify(execFile);
const MAX_CHUNKS = 20;
export const LANG_RULE = 'Write all prose in the language of the prediction question.';
const STANCES = ['supportive', 'opposing', 'neutral', 'observer'];
const FALLBACK_TYPES = [
  { name: 'Person', description: 'Any individual not covered by a more specific type', attributes: [{ name: 'role', description: 'What they do' }] },
  { name: 'Organization', description: 'Any organization not covered by a more specific type', attributes: [{ name: 'org_type', description: 'Kind of organization' }] },
];

// ---------- text ----------
async function extractText(file) {
  if (path.extname(file).toLowerCase() === '.pdf') {
    const { stdout } = await run('pdftotext', ['-layout', file, '-'], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }
  return fs.readFileSync(file, 'utf8');
}

const tidy = (t) => t.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export function chunkText(text, size = 6000, overlap = 300) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const win = text.slice(i, end);
      const cut = Math.max(win.lastIndexOf('\n\n'), win.lastIndexOf('. '));
      if (cut > size * 0.5) end = i + cut + 1;
    }
    out.push(text.slice(i, end).trim());
    if (end >= text.length) break;
    i = end - overlap;
  }
  return out.filter(Boolean);
}

const sample = (arr, n) => (arr.length <= n ? arr : Array.from({ length: n }, (_, k) => arr[Math.floor((k * arr.length) / n)]));

export function excerpt(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n\n[... middle omitted ...]\n\n${text.slice(-(max - head - 40))}`;
}

const groups = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, '');
const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v, lo, hi, dflt) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
};
const hours = (v, dflt) => {
  const h = Array.isArray(v) ? [...new Set(v.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < 24))] : [];
  return h.length ? h.sort((a, b) => a - b) : dflt;
};

async function ingest(ctx) {
  const dir = simDir(ctx.id, 'docs');
  const parts = [];
  for (const f of fs.readdirSync(dir)) {
    const text = tidy(await extractText(path.join(dir, f)));
    if (text) parts.push(`=== ${f} ===\n${text}`);
    ctx.log(`Read ${f} (${text.length.toLocaleString()} chars)`);
  }
  const text = parts.join('\n\n');
  if (!text) throw new Error('No readable text in the uploaded documents.');
  writeText(ctx.id, 'source.txt', text);
  return text;
}

// ---------- ontology ----------
const ONTOLOGY_SYSTEM = `You design the ontology for a social-media opinion simulation. You get source documents and a prediction question. Define the kinds of real-world ACTORS that could post and interact on social media about this situation, and the relationships between them.

Rules:
- Exactly 10 entity types. The first 8 are specific to these documents; the last 2 are the fallbacks "Person" (any individual) and "Organization" (any organization).
- Entity types are actors that can speak: individuals, companies, organizations, government bodies, regulators, media outlets, platforms, specific communities or groups. Never abstract concepts, topics, emotions, opinions or stances.
- Type names in PascalCase. Each has a description (max 100 characters) saying how it differs from the fallbacks, and 1-3 snake_case attributes.
- 6-10 relationship types in UPPER_SNAKE_CASE, each with a description and allowed source/target type pairs.
- analysis_summary: 3-5 sentences on what the documents describe and what the question asks.
${LANG_RULE} Names stay in English case conventions.

Reply with only JSON:
{"entity_types":[{"name":"","description":"","attributes":[{"name":"","description":""}]}],
 "edge_types":[{"name":"","description":"","source_targets":[{"source":"","target":""}]}],
 "analysis_summary":""}`;

const pascal = (s) => str(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const snakeUpper = (s) => str(s).replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();

function normalizeOntology(o) {
  const seen = new Set(['Person', 'Organization']);
  const specific = [];
  for (const t of o.entity_types || []) {
    const name = pascal(t.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    specific.push({ name, description: str(t.description).slice(0, 140), attributes: (t.attributes || []).slice(0, 3) });
  }
  const entity_types = [...specific.slice(0, 8), ...FALLBACK_TYPES];
  const typeNames = new Set(entity_types.map((t) => t.name));
  const edgeSeen = new Set();
  const edge_types = [];
  for (const e of o.edge_types || []) {
    const name = snakeUpper(e.name);
    if (!name || edgeSeen.has(name)) continue;
    edgeSeen.add(name);
    const source_targets = (e.source_targets || []).map((st) => ({ source: pascal(st.source), target: pascal(st.target) }))
      .filter((st) => typeNames.has(st.source) && typeNames.has(st.target)).slice(0, 10);
    edge_types.push({ name, description: str(e.description).slice(0, 140), source_targets });
  }
  return { entity_types, edge_types: edge_types.slice(0, 10), analysis_summary: str(o.analysis_summary) };
}

async function buildOntology(ctx, requirement, text) {
  const o = await ask(ctx, {
    tier: 'brain',
    system: ONTOLOGY_SYSTEM,
    prompt: `## Prediction question\n${requirement}\n\n## Documents\n${excerpt(text, 50000)}`,
    mock: () => ({
      entity_types: ['Company', 'Regulator', 'MediaOutlet', 'Expert', 'Customer', 'Investor', 'Employee', 'Community'].map((name) => ({ name, description: `Mock ${name}`, attributes: [] })),
      edge_types: ['REPORTS_ON', 'REGULATES', 'WORKS_FOR', 'CRITICIZES', 'SUPPORTS', 'INVESTS_IN'].map((name) => ({ name, description: `Mock ${name}`, source_targets: [] })),
      analysis_summary: `Mock analysis of: ${requirement}`,
    }),
  });
  return normalizeOntology(o);
}

// ---------- knowledge graph ----------
const EXTRACT_SYSTEM = `You extract a knowledge graph for a social-media simulation from one chunk of a document.
- List every concrete actor in the text that matches one of the given entity types: named people, organizations, media, government bodies, communities. Use the most specific type; use Person or Organization when nothing else fits. Skip abstract concepts, events, places and topics.
- Use each actor's canonical full name, the same way every time.
- summary: 1-2 sentences on who they are and their role in this situation, from this text only.
- relations: factual links between listed actors, using the given relationship types, each with a one-sentence fact.
${LANG_RULE}

Reply with only JSON:
{"entities":[{"name":"","type":"","summary":"","attributes":{}}],
 "relations":[{"source":"","target":"","type":"","fact":""}]}`;

function mockExtract(chunk, ontology) {
  const names = [...new Set(chunk.match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g) || [])].slice(0, 6);
  const types = ontology.entity_types.map((t) => t.name);
  return {
    entities: names.map((name, i) => ({ name, type: types[i % types.length], summary: `${name} appears in the source.`, attributes: {} })),
    relations: names.slice(1).map((name, i) => ({ source: names[i], target: name, type: ontology.edge_types[0]?.name || 'RELATED_TO', fact: `${names[i]} is linked to ${name}.` })),
  };
}

async function buildGraph(ctx, ontology, text) {
  const chunks = sample(chunkText(text), MAX_CHUNKS);
  const typeNames = new Set(ontology.entity_types.map((t) => t.name));
  const edgeNames = new Set(ontology.edge_types.map((t) => t.name));
  const schema = `## Entity types\n${ontology.entity_types.map((t) => `- ${t.name}: ${t.description}`).join('\n')}\n\n## Relationship types\n${ontology.edge_types.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`;
  const graph = { nodes: [], edges: [] };
  const byKey = new Map();
  const edgeKeys = new Set();
  let done = 0;

  const merge = (r) => {
    for (const e of r.entities || []) {
      const key = norm(e.name);
      if (!key) continue;
      const type = typeNames.has(pascal(e.type)) ? pascal(e.type) : 'Person';
      let n = byKey.get(key);
      if (!n) {
        n = { id: `n${graph.nodes.length + 1}`, name: str(e.name), type, summary: str(e.summary), attributes: e.attributes || {} };
        graph.nodes.push(n);
        byKey.set(key, n);
        continue;
      }
      if ((n.type === 'Person' || n.type === 'Organization') && type !== 'Person' && type !== 'Organization') n.type = type;
      const s = str(e.summary);
      if (s && !n.summary.includes(s.slice(0, 40))) n.summary = `${n.summary} ${s}`.trim().slice(0, 700);
      Object.assign(n.attributes, e.attributes || {});
    }
    for (const rel of r.relations || []) {
      const s = byKey.get(norm(rel.source));
      const t = byKey.get(norm(rel.target));
      if (!s || !t || s === t) continue;
      const type = edgeNames.has(snakeUpper(rel.type)) ? snakeUpper(rel.type) : 'RELATED_TO';
      const k = `${s.id}|${t.id}|${type}`;
      if (edgeKeys.has(k)) continue;
      edgeKeys.add(k);
      graph.edges.push({ id: `e${graph.edges.length + 1}`, source: s.id, target: t.id, type, fact: str(rel.fact) });
    }
  };

  await Promise.all(chunks.map(async (chunk, i) => {
    const r = await ask(ctx, {
      tier: 'brain',
      system: EXTRACT_SYSTEM,
      prompt: `${schema}\n\n## Text (chunk ${i + 1} of ${chunks.length})\n${chunk}`,
      mock: () => mockExtract(chunk, ontology),
    });
    merge(r);
    done++;
    ctx.set({ progress: 15 + Math.round((done / chunks.length) * 30), message: `Extracted ${done}/${chunks.length} chunks · ${graph.nodes.length} entities` });
    ctx.emit('graph', graph);
  }));
  if (!graph.nodes.length) throw new Error('No actors found in the documents. Try richer seed material.');
  return graph;
}

// ---------- personas ----------
const PERSONA_SYSTEM = `You write realistic social-media personas for an opinion simulation. Each persona must feel like a real account, grounded in the facts you are given, with its own voice, interests and stance on the situation.

For every requested ref, return one persona:
- kind: "person", "institution", "media" or "group". Institutions, media and groups are official accounts: age and gender are null, and the persona describes the account's positioning, audience, tone and official line.
- username: a plausible lowercase handle without @.
- bio: max 160 characters, written as the account's own profile bio.
- persona: 500-800 characters covering background and link to this situation, personality, how they post (tone, length, habits), what they care about, what angers or moves them, and what they have already done or said in this situation.
- stance toward the central development in the question: "supportive", "opposing", "neutral" or "observer". sentiment: -1 (hostile) to 1 (enthusiastic).
- activity (0-1, how often they post), influence (0.5-3), active_hours (local hours 0-23 when they are online). Guide: institutions activity 0.1-0.3, hours 9-17, influence 2.5-3; media 0.4-0.6, hours 7-23, influence 2-2.5; public figures and experts 0.4-0.6, influence 1.5-2; ordinary people 0.5-0.9, mostly evenings, influence 0.6-1.2.
- Keep each ref exactly as given.
${LANG_RULE}

Reply with only JSON:
{"personas":[{"ref":"","kind":"","name":"","username":"","bio":"","persona":"","age":null,"gender":null,"mbti":"","country":"","profession":"","interests":[],"stance":"","sentiment":0,"activity":0.5,"influence":1,"active_hours":[]}]}`;

const SEGMENTS_SYSTEM = `You plan the general public for a social-media simulation. Split the people who would plausibly see and react to this situation online into 4-8 distinct audience segments (by role, demographic, interest or attitude). Include critics, supporters, the indifferent and the curious. The share values sum to 1.
${LANG_RULE}
Reply with only JSON: {"segments":[{"label":"","description":"","share":0.2}]}`;

function mockPersona(ref, name) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const n = name || `${pick(['Asha', 'Ben', 'Chen', 'Dara', 'Eli', 'Farah', 'Gus', 'Hana'])} ${pick(['Rao', 'Lee', 'Smith', 'Okafor', 'Kim', 'Silva'])}`;
  return {
    ref, kind: 'person', name: n, username: n.toLowerCase().replace(/\W+/g, '_'), bio: `Mock bio for ${n}`,
    persona: `${n} is a mock persona used for offline testing.`, age: 20 + Math.floor(Math.random() * 40), gender: pick(['male', 'female']),
    mbti: pick(['INTJ', 'ENFP', 'ISTJ', 'ESFP']), country: 'India', profession: pick(['engineer', 'teacher', 'analyst', 'student']),
    interests: ['tech', 'policy'], stance: pick(STANCES), sentiment: Math.random() * 2 - 1, activity: 0.4 + Math.random() * 0.5,
    influence: 0.6 + Math.random() * 2, active_hours: [8, 9, 12, 18, 19, 20, 21, 22],
  };
}

function normalizePersona(p, id, entity) {
  const name = str(p.name) || entity?.name || `User ${id}`;
  return {
    id,
    ref: entity?.id || null,
    source_type: entity?.type || 'Public',
    kind: ['person', 'institution', 'media', 'group'].includes(p.kind) ? p.kind : 'person',
    name,
    username: str(p.username || name).toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || `user${id}`,
    bio: str(p.bio).slice(0, 200),
    persona: str(p.persona).slice(0, 1400) || entity?.summary || '',
    age: Number.isInteger(p.age) ? p.age : null,
    gender: p.gender || null,
    mbti: str(p.mbti),
    country: str(p.country),
    profession: str(p.profession),
    interests: (Array.isArray(p.interests) ? p.interests : []).map(str).filter(Boolean).slice(0, 6),
    stance: STANCES.includes(p.stance) ? p.stance : 'neutral',
    sentiment: num(p.sentiment, -1, 1, 0),
    activity: num(p.activity, 0.05, 1, 0.5),
    influence: num(p.influence, 0.3, 3, 1),
    active_hours: hours(p.active_hours, [8, 9, 10, 12, 13, 18, 19, 20, 21, 22]),
  };
}

async function buildAgents(ctx, { requirement, ontology, graph, target }) {
  const degree = new Map();
  for (const e of graph.edges) for (const k of [e.source, e.target]) degree.set(k, (degree.get(k) || 0) + 1);
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const entities = [...graph.nodes].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, target);
  const crowdCount = Math.max(0, target - entities.length);
  const brief = `## Situation\n${ontology.analysis_summary}\n\n## Prediction question\n${requirement}`;
  const results = new Map(); // ref -> raw persona
  const total = entities.length + crowdCount;
  const partial = () => {
    ctx.set({ progress: 50 + Math.round((results.size / total) * 35), message: `Wrote ${results.size}/${total} personas` });
    ctx.emit('agents', [...results.values()].map((p, i) => normalizePersona(p, i, null)));
  };

  const jobs = groups(entities, 8).map((batch) => async () => {
    const blocks = batch.map((n) => {
      const facts = graph.edges.filter((e) => e.source === n.id || e.target === n.id).slice(0, 8)
        .map((e) => `  - ${e.fact || `${nameOf.get(e.source)} ${e.type} ${nameOf.get(e.target)}`}`).join('\n');
      return `### ref: ${n.id}\nName: ${n.name}\nType: ${n.type}\nSummary: ${n.summary}\nAttributes: ${JSON.stringify(n.attributes)}\nFacts:\n${facts || '  - (none)'}`;
    }).join('\n\n');
    const r = await ask(ctx, {
      tier: 'brain', system: PERSONA_SYSTEM,
      prompt: `${brief}\n\n## Write personas for these actors from the source material\n${blocks}`,
      mock: () => ({ personas: batch.map((n) => mockPersona(n.id, n.name)) }),
    });
    for (const p of r.personas || []) if (batch.some((n) => n.id === p.ref)) results.set(p.ref, p);
    partial();
  });

  if (crowdCount) {
    const seg = await ask(ctx, {
      tier: 'brain', system: SEGMENTS_SYSTEM, prompt: brief,
      mock: () => ({ segments: [{ label: 'Everyday users', description: 'General public', share: 0.6 }, { label: 'Skeptics', description: 'Doubtful observers', share: 0.4 }] }),
    });
    const segments = (seg.segments || []).filter((s) => s.label);
    if (!segments.length) segments.push({ label: 'General public', description: 'Ordinary people following the story', share: 1 });
    const totalShare = segments.reduce((s, x) => s + (Number(x.share) || 0), 0) || segments.length;
    let next = 1;
    segments.forEach((s, i) => {
      const count = i === segments.length - 1 ? crowdCount - (next - 1) : Math.round(((Number(s.share) || 1) / totalShare) * crowdCount);
      const refs = Array.from({ length: Math.max(0, count) }, () => `crowd-${next++}`);
      for (const batch of groups(refs, 12)) {
        jobs.push(async () => {
          const r = await ask(ctx, {
            tier: 'brain', system: PERSONA_SYSTEM,
            prompt: `${brief}\n\n## Create these members of the public\nSegment: ${s.label} — ${s.description}\nWrite ${batch.length} distinct individuals (kind "person") from this segment, varied in age, job, location, temperament and stance.\nRefs: ${batch.join(', ')}`,
            mock: () => ({ personas: batch.map((ref) => mockPersona(ref)) }),
          });
          for (const p of r.personas || []) if (batch.includes(p.ref)) results.set(p.ref, p);
          partial();
        });
      }
    });
  }

  await Promise.all(jobs.map((j) => j().catch((e) => ctx.log(`Persona batch failed: ${e.message}`, 'warn'))));

  const byId = new Map(entities.map((n) => [n.id, n]));
  const agents = [];
  for (const n of entities) agents.push(normalizePersona(results.get(n.id) || { name: n.name, persona: n.summary }, agents.length, n));
  for (const [ref, p] of results) if (!byId.has(ref)) agents.push(normalizePersona(p, agents.length, null));
  const used = new Set();
  for (const a of agents) {
    let u = a.username;
    for (let k = 2; used.has(u); k++) u = `${a.username}${k}`;
    used.add(u);
    a.username = u;
  }
  return agents;
}

// ---------- clock + opening posts ----------
const CONFIG_SYSTEM = `You set up the clock and the opening moves of a social-media simulation about a real-world situation.
- Infer where the audience lives and their daily rhythm. start_hour is the local hour when the story breaks.
- total_hours (24-168): short for breaking news, longer for slow-burning topics. minutes_per_round (30-120).
- peak_hours: when this audience is most active. off_peak_hours: when almost nobody posts.
- hot_topics: 3-6 short topic tags people will discuss. narrative_direction: one or two sentences on how the conversation is likely to develop.
- initial_posts: 3-8 posts that open the conversation, each by a specific agent from the list (poster_id), on "twitter" or "reddit". Official sources and media usually post first. Reddit posts need a title. Write the content in the poster's voice.
${LANG_RULE}

Reply with only JSON:
{"timezone":"","start_hour":8,"total_hours":72,"minutes_per_round":60,"peak_hours":[],"off_peak_hours":[],"hot_topics":[],"narrative_direction":"","initial_posts":[{"poster_id":0,"platform":"twitter","title":"","content":""}],"reasoning":""}`;

async function buildConfig(ctx, { requirement, ontology, text, agents }) {
  const roster = agents.map((a) => `${a.id} | ${a.name} | ${a.kind} | ${a.profession || a.source_type} | ${a.stance}`).join('\n');
  const c = await ask(ctx, {
    tier: 'brain', system: CONFIG_SYSTEM,
    prompt: `## Situation\n${ontology.analysis_summary}\n\n## Prediction question\n${requirement}\n\n## Source excerpt\n${excerpt(text, 8000)}\n\n## Agents (id | name | kind | role | stance)\n${roster}`,
    mock: () => ({
      timezone: 'UTC+5:30', start_hour: 9, total_hours: 48, minutes_per_round: 60, peak_hours: [9, 10, 20, 21, 22], off_peak_hours: [1, 2, 3, 4, 5],
      hot_topics: ['launch', 'pricing', 'trust'], narrative_direction: 'Mock: early buzz, then skepticism.',
      initial_posts: agents.slice(0, 3).map((a, i) => ({ poster_id: a.id, platform: i % 2 ? 'reddit' : 'twitter', title: 'Mock thread', content: `Mock opening post by ${a.name}.` })),
    }),
  });
  const topInfluence = [...agents].sort((a, b) => b.influence - a.influence)[0];
  return {
    timezone: str(c.timezone),
    start_hour: Math.round(num(c.start_hour, 0, 23, 8)),
    total_hours: Math.round(num(c.total_hours, 12, 168, 72)),
    minutes_per_round: Math.round(num(c.minutes_per_round, 15, 240, 60)),
    peak_hours: hours(c.peak_hours, [9, 10, 11, 14, 15, 20, 21, 22]),
    off_peak_hours: hours(c.off_peak_hours, [0, 1, 2, 3, 4, 5]),
    hot_topics: (Array.isArray(c.hot_topics) ? c.hot_topics : []).map(str).filter(Boolean).slice(0, 8),
    narrative_direction: str(c.narrative_direction),
    reasoning: str(c.reasoning),
    initial_posts: (Array.isArray(c.initial_posts) ? c.initial_posts : []).filter((p) => str(p.content)).slice(0, 8).map((p) => ({
      poster_id: agents[Number(p.poster_id)] ? Number(p.poster_id) : topInfluence.id,
      platform: p.platform === 'reddit' ? 'reddit' : 'twitter',
      title: str(p.title),
      content: str(p.content),
    })),
  };
}

export async function prepare(ctx) {
  const { requirement, settings } = ctx.meta;
  try {
    ctx.set({ status: 'preparing', stage: 'ingest', progress: 2, message: 'Reading documents', error: null });
    const text = await ingest(ctx);

    ctx.set({ stage: 'ontology', progress: 8, message: 'Designing the ontology' });
    const ontology = await buildOntology(ctx, requirement, text);
    writeJSON(ctx.id, 'ontology.json', ontology);
    ctx.emit('ontology', ontology);
    ctx.log(`Ontology: ${ontology.entity_types.length} entity types, ${ontology.edge_types.length} relationship types`);

    ctx.set({ stage: 'graph', progress: 15, message: 'Building the knowledge graph' });
    const graph = await buildGraph(ctx, ontology, text);
    writeJSON(ctx.id, 'graph.json', graph);
    ctx.meta.counts.entities = graph.nodes.length;
    ctx.meta.counts.relations = graph.edges.length;
    ctx.log(`Graph: ${graph.nodes.length} entities, ${graph.edges.length} relations`);

    ctx.set({ stage: 'personas', progress: 50, message: 'Writing agent personas' });
    const agents = await buildAgents(ctx, { requirement, ontology, graph, target: settings.agents });
    writeJSON(ctx.id, 'agents.json', agents);
    ctx.emit('agents', agents);
    ctx.meta.counts.agents = agents.length;
    ctx.log(`Personas: ${agents.length} agents (${agents.filter((a) => a.ref).length} from the graph)`);

    ctx.set({ stage: 'config', progress: 90, message: 'Setting the clock and opening posts' });
    const config = await buildConfig(ctx, { requirement, ontology, text, agents });
    writeJSON(ctx.id, 'config.json', config);
    ctx.emit('config', config);

    ctx.set({ status: 'ready', stage: 'ready', progress: 100, message: `${agents.length} agents ready to simulate` });
    return true;
  } catch (e) {
    ctx.log(e.message, 'error');
    ctx.set({ status: 'failed', message: e.message, error: e.message });
    return false;
  }
}

// Stage 4-5: evidence export, the report agent (outline -> interviews -> grounded sections),
// chat with the report agent, and in-character interviews.
import fs from 'node:fs';
import { ask, runAgent } from './claude.mjs';
import { LANG_RULE } from './prepare.mjs';
import { appendJSONL, readJSON, readJSONL, simDir, writeJSON, writeText } from './store.mjs';

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const groups = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const readData = (id, f) => {
  try {
    return fs.readFileSync(simDir(id, 'report', 'data', f), 'utf8');
  } catch {
    return '';
  }
};

// ---------- evidence files the report agent greps ----------
export function writeEvidence(id) {
  const meta = readJSON(id, 'meta.json');
  const agents = readJSON(id, 'agents.json');
  const world = readJSON(id, 'world.json');
  const graph = readJSON(id, 'graph.json', { nodes: [], edges: [] });
  const ontology = readJSON(id, 'ontology.json', {});
  const config = readJSON(id, 'config.json', {});
  const actions = readJSONL(id, 'actions.jsonl');
  const who = (i) => `@${agents[i].username} (${agents[i].name}, ${agents[i].stance})`;
  const clock = new Map(actions.map((a) => [a.round, `Day ${a.day} ${String(a.hour).padStart(2, '0')}:00`]));
  const at = (r) => `R${r} ${clock.get(r) || ''}`.trim();
  const out = {};

  out['question.md'] = `# Prediction question\n${meta.requirement}\n\n## Situation (from the source documents)\n${ontology.analysis_summary || ''}\n\n## Simulation settings\n- Agents: ${agents.length} (${agents.filter((a) => a.ref).length} real actors from the documents, the rest generated members of the public)\n- Rounds run: ${world.round} of ${meta.settings.rounds}, ${meta.sim?.minutes_per_round || '?'} simulated minutes each, ending ${meta.sim?.clock || ''}\n- Platforms: a Twitter-like microblog and a Reddit-like forum, running in parallel\n- Hot topics at the start: ${(config.hot_topics || []).join(', ')}\n- Expected direction before the run (a forecast, not a result): ${config.narrative_direction || ''}\n`;

  const acted = new Map();
  for (const a of actions) if (a.action !== 'DO_NOTHING') acted.set(a.agent_id, (acted.get(a.agent_id) || 0) + 1);
  out['agents.md'] = `# Agents\nid | handle | name | kind | role | stance | sentiment | influence | actions | bio\n${agents.map((a) => `${a.id} | @${a.username} | ${a.name} | ${a.kind} | ${a.profession || a.source_type} | ${a.stance} | ${a.sentiment.toFixed(1)} | ${a.influence.toFixed(1)} | ${acted.get(a.id) || 0} | ${clip(a.bio, 140)}`).join('\n')}\n`;

  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
  out['graph.md'] = `# Knowledge graph from the source documents\n## Entities\n${graph.nodes.map((n) => `- ${n.name} [${n.type}]: ${n.summary}`).join('\n')}\n\n## Facts\n${graph.edges.map((e) => `- ${nameOf.get(e.source)} ${e.type} ${nameOf.get(e.target)}: ${e.fact}`).join('\n')}\n`;

  const tw = world.twitter;
  const twById = new Map(tw.map((p) => [p.id, p]));
  out['twitter.md'] = `# Microblog (Twitter-like) — every post in order\n${tw.map((p) => {
    if (p.repost_of) return `[${p.id}] ${at(p.round)} ${who(p.author)} reposted [${p.repost_of}] by @${agents[twById.get(p.repost_of).author].username}`;
    const quote = p.quote_of ? ` quoting [${p.quote_of}] @${agents[twById.get(p.quote_of).author].username} "${clip(twById.get(p.quote_of).content, 120)}" —` : '';
    return `[${p.id}] ${at(p.round)} ${who(p.author)}${quote} likes ${p.likes}, reposts ${p.reposts}, quotes ${p.quotes}: ${p.content}`;
  }).join('\n')}\n`;

  out['reddit.md'] = `# Forum (Reddit-like) — every thread with comments\n${world.reddit.map((p) => `\n## [${p.id}] "${p.title}" — ${who(p.author)}, ${at(p.round)}, score ${p.score}, ${p.comments.length} comments\n${p.content}\n${p.comments.map((c) => `- [${c.id}] ${who(c.author)} ${at(c.round)} score ${c.score}: ${c.content}`).join('\n')}`).join('\n')}\n`;

  const byType = {};
  const perRound = {};
  const stanceVoice = {};
  for (const a of actions) {
    if (a.action === 'DO_NOTHING') continue;
    byType[`${a.platform} ${a.action}`] = (byType[`${a.platform} ${a.action}`] || 0) + 1;
    perRound[a.round] = (perRound[a.round] || 0) + 1;
    if (['CREATE_POST', 'QUOTE_POST', 'CREATE_COMMENT'].includes(a.action)) {
      const s = agents[a.agent_id].stance;
      stanceVoice[s] = (stanceVoice[s] || 0) + 1;
    }
  }
  const stanceMix = {};
  for (const a of agents) stanceMix[a.stance] = (stanceMix[a.stance] || 0) + 1;
  const followers = new Map();
  for (const list of Object.values(world.follows)) for (const t of list) followers.set(t, (followers.get(t) || 0) + 1);
  const topTw = tw.filter((p) => !p.repost_of).sort((a, b) => b.likes + 2 * b.reposts + 2 * b.quotes - (a.likes + 2 * a.reposts + 2 * a.quotes)).slice(0, 10);
  const topRd = [...world.reddit].sort((a, b) => b.score + b.comments.length - (a.score + a.comments.length)).slice(0, 10);
  const rank = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  out['stats.md'] = `# Simulation statistics
## Totals
- Actions (excluding idle): ${Object.values(byType).reduce((s, x) => s + x, 0)}
${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## Stance mix of agents
${Object.entries(stanceMix).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## Who wrote the content (posts, quotes, comments by author stance)
${Object.entries(stanceVoice).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## Top microblog posts by engagement
${topTw.map((p) => `- [${p.id}] ${who(p.author)} likes ${p.likes}, reposts ${p.reposts}, quotes ${p.quotes}: ${clip(p.content, 200)}`).join('\n')}

## Top forum threads
${topRd.map((p) => `- [${p.id}] "${p.title}" by ${who(p.author)} score ${p.score}, ${p.comments.length} comments`).join('\n')}

## Most active agents
${rank(acted, 10).map(([i, n]) => `- ${who(i)}: ${n} actions`).join('\n')}

## Most followed agents
${rank(followers, 10).map(([i, n]) => `- ${who(Number(i))}: ${n} followers`).join('\n')}

## Activity per round
${Object.entries(perRound).map(([r, n]) => `${at(Number(r))}: ${n}`).join(' · ')}
`;

  for (const [f, text] of Object.entries(out)) writeText(id, `report/data/${f}`, text);
}

// ---------- interviews ----------
const INTERVIEW_SYSTEM = `You answer an interviewer's questions in character as each of these people, after a social-media storm they took part in. Speak in first person from their persona, stance and what they actually did (their activity log). Natural voice, plain text, no lists or headings. Answer every question, 2-4 sentences each. They don't know they are simulated.
${LANG_RULE}
Reply with only JSON: {"answers":[{"agent":0,"answer":""}]}`;

function activityLines(actions, agentId) {
  return actions.filter((a) => a.agent_id === agentId && a.action !== 'DO_NOTHING').slice(-12).map((a) => {
    const what = a.content ? `"${clip(a.content, 140)}"` : a.target ? `@${a.target}` : '';
    const on = a.ref_author ? ` (on @${a.ref_author}: "${clip(a.ref_content, 60)}")` : '';
    return `  - R${a.round} ${a.platform} ${a.action}${on} ${what}`;
  }).join('\n') || '  - (only watched, never acted)';
}

export async function interview(ctx, agentIds, question, history = []) {
  const agents = readJSON(ctx.id, 'agents.json');
  const actions = readJSONL(ctx.id, 'actions.jsonl');
  const convo = history.slice(-6).map((m) => `${m.role === 'user' ? 'Interviewer' : 'You'}: ${m.content}`).join('\n');
  const chosen = agentIds.map(Number).filter((i) => agents[i]);
  const results = await Promise.all(groups(chosen, 6).map(async (batch) => {
    const blocks = batch.map((i) => {
      const a = agents[i];
      return `### agent ${a.id} · @${a.username} — ${a.name} (${a.profession || a.kind}), stance: ${a.stance}\nPersona: ${a.persona}\nWhat they did in the simulation:\n${activityLines(actions, a.id)}`;
    }).join('\n\n');
    const r = await ask(ctx, {
      tier: 'crowd', system: INTERVIEW_SYSTEM,
      prompt: `${blocks}\n\n${convo ? `## Conversation so far\n${convo}\n\n` : ''}## Interviewer's question(s)\n${question}`,
      mock: () => ({ answers: batch.map((i) => ({ agent: i, answer: `Mock answer from @${agents[i].username}.` })) }),
    });
    return (r.answers || []).filter((x) => batch.includes(Number(x.agent)));
  }));
  return results.flat().map((x) => {
    const a = agents[Number(x.agent)];
    return { agent_id: a.id, name: a.name, handle: a.username, stance: a.stance, answer: String(x.answer || '') };
  });
}

// ---------- report ----------
const PLAN_SYSTEM = `You plan a prediction report about a simulated future. A swarm of AI agents, representing the real actors and the public, reacted to a situation on simulated social platforms. The simulation is a rehearsal of how things could unfold, seen from a god's-eye view.
Plan a report that answers the prediction question with what happened in the simulation: how opinion formed and shifted, who drove it, which arguments won, what risks and turning points appeared, and what it suggests will happen.
2-5 sections, no subsections. Each has a title and a focus (one sentence on what it covers and which evidence it will use).
${LANG_RULE}
Reply with only JSON: {"title":"","summary":"","sections":[{"title":"","focus":""}]}`;

const PICK_SYSTEM = `You choose who to interview after a social-media simulation, for a prediction report. Pick 5-8 agents with different stances and kinds, including the most influential and the most active. Write 3-4 short open questions (max 20 words each) about the prediction question.
${LANG_RULE}
Reply with only JSON: {"agent_ids":[0],"questions":[""]}`;

const SECTION_SYSTEM = `You write one section of a prediction report about a simulated social-media world. Your working directory holds the evidence:
- question.md: the prediction question, situation and settings
- stats.md: totals, stance mix, top posts, most active and most followed agents, activity per round
- agents.md: every agent with handle, kind, role, stance, influence and activity
- twitter.md: every microblog post in order, with engagement
- reddit.md: every forum thread with its comments and scores
- interviews.md: post-simulation interviews with selected agents
- graph.md: the knowledge graph from the source documents

Work like an analyst: use Grep and Read to collect evidence for this section (3-6 tool calls; Grep with context is usually best), then write.
Rules:
- Every claim must come from the evidence files. Never invent agents, posts, numbers or quotes.
- Quote agents verbatim as blockquotes that name them: > "..." — @handle (microblog or forum)
- Use numbers from stats.md where they help.
- No markdown headings; use **bold** lead-ins instead. 250-600 words.
- Don't repeat what earlier sections said.
- Your final message is only the section text.
${LANG_RULE}`;

const CHAT_SYSTEM = `You are the report agent for a finished social-media simulation. Answer the user's question concisely, grounded in the evidence files in your working directory (report.md if present, stats.md, agents.md, twitter.md, reddit.md, interviews.md, graph.md, question.md). Use 0-3 Grep or Read calls as needed. Quote agents as > blockquotes with their @handle. Never invent facts.
${LANG_RULE}`;

export async function generateReport(ctx) {
  const id = ctx.id;
  const t0 = Date.now();
  const log = (ev) => {
    const row = { t: Number(((Date.now() - t0) / 1000).toFixed(1)), ...ev };
    appendJSONL(id, 'report/log.jsonl', [row]);
    ctx.emit('report', row);
  };
  try {
    ctx.set({ status: 'reporting', stage: 'report', progress: 2, message: 'Planning the report', error: null });
    fs.rmSync(simDir(id, 'report'), { recursive: true, force: true });
    writeEvidence(id);
    writeText(id, 'report/log.jsonl', '');
    const cwd = simDir(id, 'report', 'data');
    const question = readData(id, 'question.md');
    const stats = readData(id, 'stats.md');

    log({ kind: 'plan_start' });
    const o = await ask(ctx, {
      tier: 'brain', system: PLAN_SYSTEM, prompt: `${question}\n\n${clip(stats, 14000)}`,
      mock: () => ({ title: 'Mock prediction report', summary: 'Mock summary.', sections: [{ title: 'How it started', focus: 'opening' }, { title: 'Who drove it', focus: 'actors' }, { title: 'What happens next', focus: 'outlook' }] }),
    });
    const outline = {
      title: String(o.title || 'Prediction report'),
      summary: String(o.summary || ''),
      sections: (o.sections || []).filter((s) => s.title).slice(0, 5).map((s) => ({ title: String(s.title), focus: String(s.focus || '') })),
    };
    if (outline.sections.length < 2) outline.sections = [{ title: 'What happened', focus: 'Overall dynamics' }, { title: 'What it suggests', focus: 'Outlook and risks' }];
    writeJSON(id, 'report/outline.json', outline);
    log({ kind: 'plan', outline });

    ctx.set({ progress: 10, message: 'Interviewing agents' });
    const pick = await ask(ctx, {
      tier: 'brain', system: PICK_SYSTEM, prompt: `${question}\n\n${clip(readData(id, 'agents.md'), 20000)}`,
      mock: () => ({ agent_ids: [0, 1, 2], questions: ['How do you feel about how this played out?'] }),
    });
    const questions = (pick.questions || []).map(String).filter(Boolean).slice(0, 4);
    const ids = (pick.agent_ids || []).map(Number).slice(0, 8);
    log({ kind: 'tool_call', tool: 'interview_agents', input: { agent_ids: ids, questions } });
    const answers = await interview(ctx, ids, questions.map((q, i) => `${i + 1}. ${q}`).join('\n'));
    writeText(id, 'report/data/interviews.md', `# Post-simulation interviews\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n${answers.map((a) => `## @${a.handle} — ${a.name} (${a.stance})\n${a.answer}`).join('\n\n')}\n`);
    log({ kind: 'tool_result', tool: 'interview_agents', preview: answers.map((a) => `@${a.handle}: ${clip(a.answer, 140)}`).join('\n') });

    const done = [];
    for (const [i, s] of outline.sections.entries()) {
      ctx.set({ progress: 20 + Math.round((i / outline.sections.length) * 75), message: `Writing "${s.title}"` });
      log({ kind: 'section_start', section: i, title: s.title });
      const prev = done.map((d, k) => `### ${outline.sections[k].title}\n${clip(d, 1500)}`).join('\n\n');
      const text = await runAgent(ctx, {
        system: SECTION_SYSTEM, cwd,
        prompt: `Report: ${outline.title}\nSummary: ${outline.summary}\nOutline:\n${outline.sections.map((x, k) => `${k + 1}. ${x.title} — ${x.focus}`).join('\n')}\n\n${prev ? `## Sections already written\n${prev}\n\n` : ''}## Write section ${i + 1}: ${s.title}\nFocus: ${s.focus}`,
        onEvent: (ev) => log({ ...ev, section: i }),
        mock: () => `**Mock finding.** This is placeholder text for "${s.title}".\n\n> "Mock quote." — @${'agent'} (microblog)`,
      });
      const markdown = text.replace(/^#+\s.*\n/gm, '').trim();
      done.push(markdown);
      writeText(id, `report/sections/${String(i + 1).padStart(2, '0')}.md`, markdown);
      log({ kind: 'section_done', section: i, title: s.title, markdown });
    }

    const full = `# ${outline.title}\n\n> ${outline.summary}\n\n${outline.sections.map((s, i) => `## ${s.title}\n\n${done[i]}`).join('\n\n')}\n`;
    writeText(id, 'report/report.md', full);
    writeText(id, 'report/data/report.md', full);
    log({ kind: 'done' });
    ctx.set({ status: 'reported', stage: 'reported', progress: 100, message: 'Report ready' });
  } catch (e) {
    log({ kind: 'error', message: e.message });
    ctx.log(e.message, 'error');
    ctx.set({ status: 'simulated', stage: 'simulated', message: `Report failed: ${e.message}`, error: e.message });
  }
}

export async function chat(ctx, { message, history = [] }) {
  if (!fs.existsSync(simDir(ctx.id, 'report', 'data', 'stats.md'))) writeEvidence(ctx.id);
  const convo = history.slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`).join('\n\n');
  return runAgent(ctx, {
    system: CHAT_SYSTEM,
    cwd: simDir(ctx.id, 'report', 'data'),
    prompt: `${convo ? `## Conversation so far\n${convo}\n\n` : ''}## User's question\n${message}`,
    onEvent: (ev) => ctx.emit('chat', ev),
    mock: () => `Mock answer to: ${message}`,
  });
}

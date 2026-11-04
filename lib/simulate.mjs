// Stage 3: the round loop. Two platforms (Twitter-like, Reddit-like) run side by side;
// each round Claude plays the active agents in batches, one action per agent.
import { ask } from './claude.mjs';
import { LANG_RULE } from './prepare.mjs';
import { writeEvidence } from './report.mjs';
import { appendJSONL, readJSON, writeJSON, writeText } from './store.mjs';

const MAX_ACTIVE = 60; // per platform per round
const BATCH = 12; // agents per Claude call
const FEED_SIZE = 6;
const PLATFORMS = ['twitter', 'reddit'];

const ACTIONS = {
  twitter: {
    CREATE_POST: '{"content"} max 280 characters',
    LIKE_POST: '{"post_id"}',
    REPOST: '{"post_id"}',
    QUOTE_POST: '{"post_id","content"}',
    FOLLOW: '{"user"} handle',
    DO_NOTHING: '{}',
  },
  reddit: {
    CREATE_POST: '{"title","content"}',
    CREATE_COMMENT: '{"post_id","content"}',
    LIKE_POST: '{"post_id"} upvote',
    DISLIKE_POST: '{"post_id"} downvote',
    LIKE_COMMENT: '{"comment_id"} upvote',
    DISLIKE_COMMENT: '{"comment_id"} downvote',
    FOLLOW: '{"user"} handle',
    MUTE: '{"user"} handle',
    DO_NOTHING: '{}',
  },
};

const actSystem = (platform) => `You are the engine of a social-media simulation on a ${platform === 'twitter' ? 'Twitter-like microblog' : 'Reddit-like forum'}. You play several independent users at once. Each user decides alone, from their own persona, stance, mood, memory and only the posts in their own feed. They do not know they are simulated and never mention it.

Each user takes exactly one action this turn:
${Object.entries(ACTIONS[platform]).map(([k, v]) => `- ${k} ${v}`).join('\n')}

Behave like real people: most scroll and react more than they write; they write when they have something to say; vary length, tone and register; agree, argue, joke, ask, correct; no hashtag spam; never repeat an earlier post. Only use post, comment and user ids that appear in that user's own feed.
${LANG_RULE}

Reply with only JSON, one entry per user, omitting unused fields:
{"actions":[{"agent":0,"action":"","post_id":"","comment_id":"","user":"","title":"","content":""}]}`;

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const groups = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const wordsOf = (s) => new Set(String(s).toLowerCase().match(/\p{L}{4,}/gu) || []);

function clockAt(config, mpr, round) {
  const m = config.start_hour * 60 + round * mpr;
  return { day: Math.floor(m / 1440) + 1, hour: Math.floor(m / 60) % 24, minute: m % 60 };
}
const fmtClock = (c) => `Day ${c.day}, ${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;

function seedFollows(agents) {
  const follows = {};
  for (const a of agents) {
    const weights = agents.map((b) => (b.id === a.id ? 0 : b.influence ** 2 * (b.stance === a.stance ? 1.5 : 1)));
    const total = weights.reduce((s, w) => s + w, 0);
    const want = Math.min(agents.length - 1, 5 + Math.floor(Math.random() * 11));
    const set = new Set();
    for (let guard = 0; set.size < want && guard < 300; guard++) {
      let r = Math.random() * total;
      let i = 0;
      while (r > weights[i]) r -= weights[i++];
      if (agents[i] && agents[i].id !== a.id) set.add(agents[i].id);
    }
    follows[a.id] = [...set];
  }
  return follows;
}

function pickActive(agents, config, hour) {
  const mult = config.peak_hours.includes(hour) ? 1.5 : config.off_peak_hours.includes(hour) ? 0.3 : 1;
  const target = Math.min(MAX_ACTIVE, Math.max(1, Math.round((0.1 + Math.random() * 0.2) * agents.length * mult)));
  const pool = agents.filter((a) => Math.random() < a.activity * (a.active_hours.includes(hour) ? 1 : 0.1));
  return shuffle(pool).slice(0, target);
}

class World {
  constructor(agents, topics) {
    this.agents = agents;
    this.byHandle = new Map(agents.map((a) => [a.username, a]));
    this.topics = topics.join(' ');
    this.interestWords = new Map(agents.map((a) => [a.id, wordsOf(`${a.interests.join(' ')} ${topics.join(' ')}`)]));
    this.state = { round: 0, seq: { T: 0, R: 0, C: 0 }, twitter: [], reddit: [], follows: seedFollows(agents), mutes: {}, memory: {} };
    this.posts = new Map();
    this.comments = new Map();
  }

  remember(agentId, line) {
    const m = (this.state.memory[agentId] ||= []);
    m.push(line);
    if (m.length > 6) m.shift();
  }

  relevance(agent, text) {
    const w = wordsOf(text);
    let hit = 0;
    for (const x of this.interestWords.get(agent.id)) if (w.has(x)) hit++;
    return Math.min(1, hit / 3);
  }

  feed(platform, agent, round) {
    const muted = new Set(this.state.mutes[agent.id] || []);
    const pool = this.state[platform].filter((p) => p.author !== agent.id && !muted.has(p.author) && round - p.round <= 12);
    if (!pool.length) return [];
    if (platform === 'twitter') {
      const following = new Set(this.state.follows[agent.id] || []);
      const pop = (p) => p.likes + 2 * p.reposts + 2 * p.quotes;
      const maxPop = Math.log1p(Math.max(1, ...pool.map(pop)));
      const score = (p) => 0.4 * Math.exp(-(round - p.round) / 4) + 0.3 * (Math.log1p(pop(p)) / maxPop)
        + 0.3 * this.relevance(agent, p.content) + (following.has(p.author) ? 0.5 : 0) + Math.random() * 0.15;
      return pool.map((p) => [score(p), p]).sort((a, b) => b[0] - a[0]).slice(0, FEED_SIZE).map((x) => x[1]);
    }
    const hot = (p) => (p.score + p.comments.length + 1) / (round - p.round + 2) ** 1.5;
    const maxHot = Math.max(...pool.map(hot)) || 1;
    const score = (p) => 0.7 * (hot(p) / maxHot) + 0.3 * this.relevance(agent, `${p.title} ${p.content}`) + Math.random() * 0.1;
    return pool.map((p) => [score(p), p]).sort((a, b) => b[0] - a[0]).slice(0, FEED_SIZE).map((x) => x[1]);
  }

  render(platform, p) {
    const a = this.agents[p.author];
    if (platform === 'twitter') {
      const stats = `♥${p.likes} ↻${p.reposts} ❝${p.quotes}`;
      if (p.repost_of) {
        const o = this.posts.get(p.repost_of);
        return `[${p.id}] @${a.username} reposted @${this.agents[o.author].username}: "${clip(o.content, 200)}" (${stats})`;
      }
      if (p.quote_of) {
        const o = this.posts.get(p.quote_of);
        return `[${p.id}] @${a.username} (${a.name}) quoting @${this.agents[o.author].username} "${clip(o.content, 100)}": "${clip(p.content, 220)}" (${stats})`;
      }
      return `[${p.id}] @${a.username} (${a.name}): "${clip(p.content, 240)}" (${stats})`;
    }
    const top = [...p.comments].sort((x, y) => y.score - x.score).slice(0, 2)
      .map((c) => `\n    [${c.id}] @${this.agents[c.author].username}: "${clip(c.content, 120)}" (score ${c.score})`).join('');
    return `[${p.id}] "${clip(p.title, 100)}" by @${a.username} · score ${p.score} · ${p.comments.length} comments\n    ${clip(p.content, 200)}${top}`;
  }

  newPost(platform, fields) {
    const key = platform === 'twitter' ? 'T' : 'R';
    const p = platform === 'twitter'
      ? { id: `${key}${++this.state.seq[key]}`, likes: 0, reposts: 0, quotes: 0, likers: [], ...fields }
      : { id: `${key}${++this.state.seq[key]}`, title: '', score: 0, votes: {}, comments: [], ...fields };
    this.state[platform].push(p);
    this.posts.set(p.id, p);
    return p;
  }

  // Apply one chosen action; returns the log record, or null if it was invalid.
  apply(platform, agent, a, round, clock) {
    const rec = { round, day: clock.day, hour: clock.hour, platform, agent_id: agent.id, agent: agent.name, handle: agent.username, action: a.action };
    const content = String(a.content || '').trim();
    const target = this.byHandle.get(String(a.user || '').replace(/^@/, '').toLowerCase());
    let p = this.posts.get(String(a.post_id || '').trim());
    if (p && p.repost_of) p = this.posts.get(p.repost_of);
    if (p && !p.id.startsWith(platform === 'twitter' ? 'T' : 'R')) p = null;
    const ref = (post) => Object.assign(rec, { post_id: post.id, ref_author: this.agents[post.author].username, ref_content: clip(post.content || post.title, 200) });
    const vote = (obj, v) => {
      const prev = obj.votes[agent.id] || 0;
      if (prev === v) return false;
      obj.score += v - prev;
      obj.votes[agent.id] = v;
      return true;
    };

    switch (a.action) {
      case 'CREATE_POST': {
        if (!content && !a.title) return null;
        const post = this.newPost(platform, { author: agent.id, round, content: content.slice(0, platform === 'twitter' ? 400 : 3000), title: String(a.title || '').slice(0, 200) });
        Object.assign(rec, { post_id: post.id, title: post.title || undefined, content: post.content });
        this.remember(agent.id, `R${round} ${platform}: posted ${post.title ? `"${clip(post.title, 60)}" ` : ''}"${clip(post.content, 120)}"`);
        return rec;
      }
      case 'LIKE_POST':
      case 'DISLIKE_POST': {
        if (!p) return null;
        if (platform === 'twitter') {
          if (a.action === 'DISLIKE_POST' || p.likers.includes(agent.id)) return null;
          p.likers.push(agent.id);
          p.likes++;
        } else if (!vote(p, a.action === 'LIKE_POST' ? 1 : -1)) return null;
        ref(p);
        this.remember(agent.id, `R${round} ${platform}: ${a.action === 'LIKE_POST' ? 'liked' : 'downvoted'} @${rec.ref_author}'s post "${clip(rec.ref_content, 60)}"`);
        return rec;
      }
      case 'REPOST': {
        if (!p || platform !== 'twitter' || p.author === agent.id) return null;
        p.reposts++;
        const post = this.newPost('twitter', { author: agent.id, round, content: '', repost_of: p.id });
        ref(p).new_post_id = post.id;
        this.remember(agent.id, `R${round} twitter: reposted @${rec.ref_author} "${clip(rec.ref_content, 60)}"`);
        return rec;
      }
      case 'QUOTE_POST': {
        if (!p || !content || platform !== 'twitter') return null;
        p.quotes++;
        const post = this.newPost('twitter', { author: agent.id, round, content: content.slice(0, 400), quote_of: p.id });
        Object.assign(ref(p), { content: post.content, new_post_id: post.id });
        this.remember(agent.id, `R${round} twitter: quoted @${rec.ref_author} with "${clip(content, 100)}"`);
        return rec;
      }
      case 'CREATE_COMMENT': {
        if (!p || !content || platform !== 'reddit') return null;
        const c = { id: `C${++this.state.seq.C}`, author: agent.id, round, content: content.slice(0, 1500), score: 0, votes: {} };
        p.comments.push(c);
        this.comments.set(c.id, { c, post: p });
        Object.assign(ref(p), { comment_id: c.id, content: c.content });
        this.remember(agent.id, `R${round} reddit: commented on "${clip(p.title, 50)}": "${clip(content, 100)}"`);
        return rec;
      }
      case 'LIKE_COMMENT':
      case 'DISLIKE_COMMENT': {
        const hit = this.comments.get(String(a.comment_id || '').trim());
        if (!hit || !vote(hit.c, a.action === 'LIKE_COMMENT' ? 1 : -1)) return null;
        Object.assign(rec, { comment_id: hit.c.id, post_id: hit.post.id, ref_author: this.agents[hit.c.author].username, ref_content: clip(hit.c.content, 200) });
        return rec;
      }
      case 'FOLLOW':
      case 'MUTE': {
        if (!target || target.id === agent.id) return null;
        const map = a.action === 'FOLLOW' ? this.state.follows : this.state.mutes;
        const list = (map[agent.id] ||= []);
        if (list.includes(target.id)) return null;
        list.push(target.id);
        rec.target = target.username;
        if (a.action === 'FOLLOW') this.remember(agent.id, `R${round} ${platform}: followed @${target.username}`);
        return rec;
      }
      case 'DO_NOTHING':
        return rec;
      default:
        return null;
    }
  }
}

function agentBlock(world, platform, agent, round) {
  const feed = world.feed(platform, agent, round);
  const memory = (world.state.memory[agent.id] || []).map((m) => `  - ${m}`).join('\n') || '  - (nothing yet)';
  const mood = agent.sentiment.toFixed(1);
  return `### agent ${agent.id} · @${agent.username} — ${agent.name} (${agent.profession || agent.kind}) · stance: ${agent.stance} · mood: ${mood}
Persona: ${clip(agent.persona, 520)}
Recent activity:
${memory}
Feed:
${feed.map((p) => `  ${world.render(platform, p)}`).join('\n') || '  (nothing new in the feed)'}`;
}

function mockAct(world, platform, batch, round) {
  const verbs = Object.keys(ACTIONS[platform]);
  return {
    actions: batch.map((agent) => {
      const feed = world.feed(platform, agent, round);
      const p = feed[Math.floor(Math.random() * feed.length)];
      const action = p ? verbs[Math.floor(Math.random() * verbs.length)] : 'CREATE_POST';
      const c = p?.comments?.[0];
      const other = world.agents[Math.floor(Math.random() * world.agents.length)];
      return { agent: agent.id, action, post_id: p?.id, comment_id: c?.id, user: other.username, title: `Mock thread R${round}`, content: `Mock take from @${agent.username} in round ${round}.` };
    }),
  };
}

export async function simulate(ctx, { rounds }) {
  const id = ctx.id;
  const agents = readJSON(id, 'agents.json');
  const config = readJSON(id, 'config.json');
  const ontology = readJSON(id, 'ontology.json');
  const mpr = Math.max(config.minutes_per_round, Math.ceil((config.total_hours * 60) / rounds));
  const world = new World(agents, config.hot_topics);
  const counts = { posts: 0, comments: 0, actions: 0, twitter: 0, reddit: 0 };
  const tally = (recs) => {
    for (const r of recs) {
      if (r.action === 'DO_NOTHING') continue;
      counts.actions++;
      counts[r.platform]++;
      if (r.action === 'CREATE_POST' || r.action === 'QUOTE_POST') counts.posts++;
      if (r.action === 'CREATE_COMMENT') counts.comments++;
    }
  };

  ctx.stopRequested = false;
  writeText(id, 'actions.jsonl', '');
  ctx.set({
    status: 'running', stage: 'simulation', progress: 0, message: 'Seeding opening posts', error: null,
    settings: { ...ctx.meta.settings, rounds },
    sim: { round: 0, rounds, minutes_per_round: mpr, clock: fmtClock(clockAt(config, mpr, 0)) },
  });
  ctx.log(`Simulation: ${agents.length} agents, ${rounds} rounds of ${mpr} simulated minutes`);

  const seedClock = clockAt(config, mpr, 0);
  const seeded = config.initial_posts.map((p) => world.apply(p.platform, agents[p.poster_id], { action: 'CREATE_POST', title: p.title || (p.platform === 'reddit' ? p.content.slice(0, 80) : ''), content: p.content }, 0, seedClock)).filter(Boolean);
  appendJSONL(id, 'actions.jsonl', seeded);
  tally(seeded);
  ctx.emit('actions', seeded);

  const background = clip(ontology.analysis_summary, 600);
  let failedRounds = 0;
  for (let round = 1; round <= rounds && !ctx.stopRequested; round++) {
    const clock = clockAt(config, mpr, round);
    const header = `Simulated time: ${fmtClock(clock)} (round ${round} of ${rounds}).\nBackground everyone has heard: ${background}`;
    let calls = 0;
    let failures = 0;

    const decided = await Promise.all(PLATFORMS.map(async (platform) => {
      const active = pickActive(agents, config, clock.hour);
      const out = await Promise.all(groups(active, BATCH).map(async (batch) => {
        calls++;
        const prompt = `${header}\n\n${batch.map((a) => agentBlock(world, platform, a, round)).join('\n\n')}`;
        try {
          const r = await ask(ctx, { tier: 'crowd', system: actSystem(platform), prompt, mock: () => mockAct(world, platform, batch, round) });
          const ids = new Set(batch.map((a) => a.id));
          return (r.actions || []).filter((x) => ids.has(Number(x.agent))).map((x) => ({ platform, agent: agents[Number(x.agent)], a: x }));
        } catch (e) {
          failures++;
          ctx.log(`Round ${round} ${platform} batch failed: ${e.message}`, 'warn');
          return [];
        }
      }));
      return out.flat();
    }));

    if (calls && failures === calls) {
      if (++failedRounds >= 2) {
        ctx.set({ status: 'failed', message: 'Claude calls keep failing; simulation stopped.', error: 'claude calls failing' });
        return;
      }
    } else failedRounds = 0;

    const recs = shuffle(decided.flat()).map((d) => world.apply(d.platform, d.agent, { ...d.a, action: String(d.a.action || '').toUpperCase() }, round, clock)).filter(Boolean);
    world.state.round = round;
    writeJSON(id, 'world.json', world.state);
    appendJSONL(id, 'actions.jsonl', recs);
    tally(recs);
    ctx.emit('actions', recs);
    ctx.meta.counts = { ...ctx.meta.counts, ...counts };
    ctx.set({
      progress: Math.round((round / rounds) * 100),
      message: `Round ${round}/${rounds} · ${fmtClock(clock)} · ${recs.filter((r) => r.action !== 'DO_NOTHING').length} actions`,
      sim: { round, rounds, minutes_per_round: mpr, clock: fmtClock(clock) },
    });
  }

  writeJSON(id, 'world.json', world.state);
  writeEvidence(id);
  const stopped = ctx.stopRequested;
  ctx.log(stopped ? 'Simulation stopped early' : 'Simulation complete');
  ctx.set({ status: 'simulated', stage: 'simulated', progress: 100, message: stopped ? `Stopped at round ${world.state.round}` : 'Simulation complete' });
}

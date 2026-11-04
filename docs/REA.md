# MiroFish reverse-engineering notes

Source: github.com/666ghj/MiroFish at commit `7657031` (3 Nov 2026), read as source (Flask + Vue).
OASIS (`camel-oasis`) and Zep Cloud are external dependencies, not in the repo.

## Observed in the source

**Ontology** (`backend/app/services/ontology_generator.py`): one LLM call over the requirement + up
to 50k chars of documents. Exactly 10 entity types, last two forced to `Person` / `Organization`;
6-10 edge types; only actors that "can speak on social media" (no topics, emotions or stances).

**Graph** (`graph_builder.py`, `zep_entity_reader.py`): 500-char chunks (50 overlap) sent to Zep as
episodes; Zep does the extraction, dedupe and summaries. Every typed node becomes an agent, with no cap.

**Personas** (`oasis_profile_generator.py`): one call per entity (5 in parallel). ~2000-char persona
plus bio, age, gender, MBTI, country, profession, topics. Follower/karma counts are random.
Quirk: only 10 type names count as "individuals"; Celebrity, Executive and Lawyer get the institution
prompt (age 30, gender "other").

**Config** (`simulation_config_generator.py`): time config (24-168 h, 30-120 min/round, peak and
off-peak hours), event config (hot topics, narrative direction, initial posts by type), per-agent
config in batches of 15 (activity, posts/hour, active hours, stance, sentiment, influence, delay).

**Runtime** (`scripts/run_parallel_simulation.py`): rounds = hours × 60 / minutes, truncated by
`max_rounds`. Per round and per platform, target = uniform(min, max) × (1.5 peak | 0.3 off-peak | 1);
candidates = agents online this hour passing `random() < activity_level`; one OASIS step each.
Only `activity_level` and `active_hours` are used at runtime. Stance, sentiment, influence,
posts/hour, recommender weights, hot topics and narrative are generated but never read.
Twitter actions: CREATE_POST, LIKE_POST, REPOST, QUOTE_POST, FOLLOW, DO_NOTHING. Reddit adds
comments, up/down votes on posts and comments, SEARCH, TREND, REFRESH, MUTE.

**Report** (`report_agent.py`, `zep_tools.py`): outline (2-5 sections), then a per-section ReACT loop
(3-5 tool calls: insight_forge, panorama_search, quick_search, interview_agents) over the Zep graph,
quotes as blockquotes, no headings. Chat mode allows up to 2 tool calls.

**UI** (`frontend/src`): 5 steps (graph, env setup, dual simulation, report, interaction), a
persistent d3 graph panel beside the workbench, dual-sided action timeline, report paper with a live
agent-workflow log, and chat/interview/survey tabs.

## Inferred (OASIS internals, not verified)

Feeds come from OASIS recommenders (twhin-bert on Twitter, hot-score on Reddit). Each agent picks
one action per turn by function calling. Memory is the CAMEL chat history.

## What Swarm Studio does differently

| MiroFish | Swarm Studio | Why |
|---|---|---|
| OpenAI-compatible API key + Zep Cloud | `claude -p` on the user's subscription; graph kept locally | no per-token bill, no external services |
| Zep extracts from 500-char chunks | Claude extracts from ~6000-char chunks (max 20), merged by name | far fewer calls |
| One LLM call per agent action (OASIS) | One call plays up to 12 agents, each seeing only their own feed | ~10× fewer calls |
| Agents = graph entities only | Graph actors (top by degree) + generated public crowd up to the target size | small documents still give a crowd |
| Stance, sentiment and influence unused at runtime | They shape the prompt, follow graph and feed ranking | the config actually matters |
| `max_rounds` truncates the timeline | Minutes per round stretch so the whole horizon is covered | 30 rounds still reach day 3 |
| Graph appears only when the build finishes | Graph grows live while chunks are extracted | |
| Report tools query Zep | A tool-using Claude agent Greps/Reads exported evidence files | real tool calls, auditable |

## Unknowns

OASIS's exact per-turn prompt, feed sizes and recommender parameters, and Zep's extraction prompts.
None are needed for this rebuild.

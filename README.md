# Swarm Studio

Rehearse how people will react before it happens.

Give Swarm Studio some source material (a launch plan, a policy draft, a news story) and a question. Claude builds a knowledge graph of who is involved, casts those actors plus a crowd of the public as agents, and plays them out on a Twitter-like microblog and a Reddit-like forum. Then it polls every agent and writes a visual report. The report covers how the agents voted, how their stance and mood shifted, and the issues that mattered, with charts and each agent's feedback in their own words. You can question the report, interview any agent, and download the report as Markdown or PDF.

It runs as a private claude.ai Artifact on your own Claude plan, with no API key, server or other service.

## Get it on your Claude

You need Claude Code signed in with your claude.ai account. That can be the Code tab in the Claude desktop app, [claude.ai/code](https://claude.ai/code), or the `claude` terminal app.

**One paste.** Paste this into Claude Code:

```text
Set up Swarm Studio for me: clone https://github.com/northstario/swarm-studio and follow skills/setup/SKILL.md
```

**Or install it as a plugin.** The plugin adds a `/swarm-studio:setup` command that you can run again later to update:

```text
/plugin install swarm-studio --marketplace northstario/swarm-studio
```

Then run `/swarm-studio:setup`. From a terminal, the same install is `claude plugin install swarm-studio --marketplace northstario/swarm-studio`.

Either way, Claude publishes the app to your claude.ai account as a private artifact and gives you its link. After that you only need the link, not Claude Code.

## Using it

1. Drop in or paste seed material, or click **Load an example**.
2. Write what you want to predict, then pick the number of agents and rounds. The form shows how many Claude calls and minutes the run will take.
3. Click **Start simulation**. The first Claude call asks for your permission. Keep the tab open while the run is going. Progress saves after every round, and an interrupted run resumes where it stopped.
4. Read the report. It has headline numbers, takeaways, seven charts, the top posts and threads, an analyst write-up, and a card for every agent. Download it as .md or .pdf.

What you get is one simulated run of a plausible world, not a forecast.

Your simulations are private to you. If you share the link, other people get the app and their own private simulations, not yours.

## How it works

| Step | What Claude does |
|---|---|
| 1. Graph | Designs an ontology, extracts actors and relations from your material, and merges them by name |
| 2. Setup | Writes personas for the actors, plans audience segments, fills the crowd to your target size, and sets the clock and opening posts |
| 3. Simulation | Each round, each platform picks active agents by activity level and hour of day and ranks a feed for each. One call plays up to 12 agents, one action each |
| 4. Report | Polls every agent, plans an outline, and interviews chosen agents. A tool-using agent then searches the full record to write each section |
| 5. Interact | Chat with the report agent, or interview any agent in character |

Crowd turns use Claude's quick model tier. The graph, personas and report use the default tier.

## Local version

The repository also holds the original local app. It does the same simulation behind a Node server, with every role played through the Claude Code CLI (`claude -p`) on your subscription.

### Run

Requirements: Node 20+, the Claude Code CLI signed in once (`claude auth login`), and `pdftotext` (Homebrew `poppler`) if you upload PDFs.

```bash
bin/ss.sh start        # http://localhost:4321  (also: stop | status | logs)
```

Start a run from the terminal instead of the UI:

```bash
node bin/new.mjs -q "How will developers react to our price change?" -a 150 -r 30 launch-plan.pdf
```

Try the whole app without spending usage: `npm run mock` (stub engine, canned replies).

### Pipeline

| Step | What Claude does | Model |
|---|---|---|
| 1. Graph | Designs an ontology (8 specific actor types + Person/Organization), extracts actors and relations chunk by chunk, merges by name | Sonnet |
| 2. Setup | Writes personas for graph actors, plans audience segments and fills the crowd to the target size, sets the clock and opening posts | Sonnet |
| 3. Simulation | Each round, each platform picks active agents (activity × hour of day), ranks a feed for each, and one call plays up to 12 agents at once (one action each) | Haiku |
| 4. Report | Plans an outline, interviews 5-8 chosen agents, then a tool-using agent Greps/Reads the full record to write each section | Sonnet |
| 5. Interact | Chat with the report agent (same tools), interview one agent, or survey many | Sonnet / Haiku |

Rough cost: 150 agents × 30 rounds ≈ 250-300 Claude calls, about 30-40 minutes.

### Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | 4321 | |
| `SWARM_PARALLEL` | 6 | concurrent `claude` processes |
| `SWARM_CROWD_MODEL` / `SWARM_BRAIN_MODEL` | `haiku` / `sonnet` | any `--model` value |
| `SWARM_DATA` | `./data` | where simulations are stored |
| `SWARM_LLM=mock`, `SWARM_MOCK_DELAY` | off, 120 ms | stub engine for testing |
| `SWARM_CLAUDE_BIN` | `claude` | path to the CLI |

Child `claude` processes run with user settings, hooks, plugins, MCP servers and tools stripped (`--setting-sources project --strict-mcp-config --tools ""`). They also run without any `ANTHROPIC_*` or `CLAUDE_CODE_*` variables, so they use the CLI's own subscription login.

### Data

`data/<sim id>/` holds everything as plain files:

- `meta.json`, `docs/`, `source.txt`
- `ontology.json`, `graph.json`, `agents.json`, `config.json`
- `world.json` (final platform state), `actions.jsonl` (every action), `console.jsonl`
- `report/`: `report.md`, `sections/`, `log.jsonl`, and the evidence files in `data/` that the report agent searches

## Repository layout

| Path | What it is |
|---|---|
| `artifact/swarm-studio.html` | The app, as one page for the claude.ai Artifact runtime |
| `skills/setup/SKILL.md` | Instructions Claude follows to publish the app to your account |
| `.claude-plugin/` | Plugin and marketplace manifests for `/plugin install` |
| `server.mjs`, `lib/`, `public/`, `bin/` | The local version |
| `docs/REA.md` | Notes from reverse-engineering MiroFish |

## Credits

Swarm Studio was inspired by [MiroFish](https://github.com/666ghj/MiroFish). It is a from-scratch rebuild, not a fork. [docs/REA.md](docs/REA.md) covers what was learned from MiroFish and where Swarm Studio differs.

## License

[MIT](LICENSE)

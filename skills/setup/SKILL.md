---
name: setup
description: Publish Swarm Studio, a swarm-intelligence simulator that runs on the user's own Claude, as a private claude.ai Artifact on their account (or update the copy they already have) and give back the link. Use when the user says "set up Swarm Studio", "install Swarm Studio", "update Swarm Studio", or runs /swarm-studio:setup.
---

# Set up Swarm Studio

Swarm Studio is one HTML page: `artifact/swarm-studio.html` at the root of this plugin, which is `${CLAUDE_PLUGIN_ROOT}/artifact/swarm-studio.html`. If you are reading this file from a clone of the repository rather than an installed plugin, the page is `../../artifact/swarm-studio.html` from this file.

Published as a claude.ai Artifact, the page runs every simulation on the viewer's own Claude plan and saves each viewer's simulations privately to them. Publish the file exactly as it is. You are publishing a finished page, not writing one: never edit, trim, restyle or "fix" it.

## 1. Check you can publish

You need the `Artifact` tool. Claude Code has it when it is signed in with a claude.ai account: the Code tab in the Claude desktop app, claude.ai/code, or the `claude` terminal app. If you don't have it, stop and tell the user that Swarm Studio is a claude.ai Artifact, so it needs Claude Code signed in with their Claude account. A Claude Code session that uses an API key can't publish artifacts.

## 2. New copy or update?

List the user's artifacts (`action: "list"`) and look for one titled "Swarm Studio".

- **None:** publish a new one (step 3).
- **One or more:** ask whether to update the one they have, which keeps their simulations and its link, or to make a separate new copy. To update, first read it (`action: "read"` with its url), as the Artifact tool requires, then publish with that `url` in step 3.

## 3. Publish

1. Copy the page unchanged into your scratchpad directory, or into the working directory if you have no scratchpad: `cp "<page path from above>" "<scratchpad>/swarm-studio.html"`.
2. Read the whole copy before publishing, as the Artifact tool requires for any file you did not write. It is about 3,050 lines, so read it in chunks.
3. The Artifact tool asks you to load the `artifact-capabilities` skill before you declare capabilities. Load it, then call Artifact with:
   - `action`: `"publish"`
   - `file_path`: the copy
   - `capabilities`: exactly `{"sample": {}, "db": {}, "user": {}, "downloads": true}`
     - `sample` runs the agents on the viewer's Claude.
     - `db` and `user` save each viewer's simulations privately.
     - `downloads` lets viewers save a report as .md or .pdf.
   - `icon`: `"network"` (for a new copy only)
   - `description`: `"Swarm-intelligence simulator: Claude plays every agent on a microblog and a forum, then writes a visual report."`
   - `url`: only when updating an existing copy
   - Leave out `contract`.

If the publish is refused because a capability isn't available on their account, tell the user which one. Don't publish without it, because the app needs all four.

## 4. Tell the user

Give the link, then in a few short lines:

- Open it, drop in or paste seed material (PDF, Markdown or text), or click **Load an example**. Write what you want to predict, pick the number of agents and rounds, and click **Start simulation**.
- The first Claude call asks for their permission. Runs use their Claude plan, and the form shows an estimate of the number of calls and minutes before each run.
- Keep the page open while a run is going. An interrupted run picks up where it stopped.
- Each person who opens the link gets their own private simulations. Sharing the link shares the app, not their runs.

Offer to pin it to their claude.ai sidebar, and only pin it if they say yes.

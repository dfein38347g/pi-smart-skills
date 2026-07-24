# pi-smart-skills

Standalone [pi](https://github.com/earendil-works/pi) extension that uses QMD hybrid search to lazily inject the most relevant skills into the system prompt.

## Overview

Instead of loading all skills into every session, `pi-smart-skills` ranks skills by relevance to the user's current prompt using QMD's hybrid search (expansion + BM25 + vector + rerank) and injects only the top matches. This reduces system prompt size, improves response quality, and speeds up inference.

## Architecture

- **Single-file extension** — no build step, runs via pi's jiti loader
- **Background cron** — re-indexes skills every 5 minutes using `qmd update`
- **Top-3 stability check** — only rewrites the system prompt when the top-3 ranked skills change, preventing KV cache thrashing
- **Aggressive failover** — on any error, timeout, or empty result, all skills remain in the system prompt

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent installed
- [QMD](https://github.com/qmd-remote/qmd) CLI available at `~/.local/bin/qmd`

## Installation

```bash
mkdir -p ~/.pi/agent/extensions/pi-smart-skills
# Place the extension file at:
# ~/.pi/agent/extensions/pi-smart-skills/index.ts
```

pi will auto-load the extension on next start.

## Configuration

Optional config at `~/.pi/agent/pi-smart-skills.json`:

```json
{
  "maxResults": 10,
  "promptCharLimit": 60000,
  "stabilityWindow": 3,
  "qmdTimeoutMs": 5000,
  "cacheTtlMs": 60000,
  "cronIntervalMs": 300000
}
```

See the plan in `plans/` for default values and detailed behavior.

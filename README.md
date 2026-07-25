# pi-smart-skills

[pi](https://github.com/earendil-works/pi) extension that uses [QMD](https://github.com/qmd-remote/qmd) hybrid search to lazily inject the most relevant skills into the system prompt — keeping context lean while always including project-local skills.

## What it does

When you have many skills installed, injecting all of them into every session wastes tokens and slows inference. This extension filters global skills by semantic relevance to your prompt, while always including project-local skills.

**Two skill sources:**

| Source | Location | Behavior |
|--------|----------|----------|
| **Project skills** | `<cwd>/.pi/skills/*/SKILL.md` | Always included (name + description), bypass QMD entirely |
| **Global skills** | Configurable directories (default `~/.pi/agent/skills/`) | Filtered by QMD semantic relevance to user prompt |

Project skills are deduplicated against global skills by name — if a skill exists in both locations, the project-local version wins.

## How it works

```
session_start
  ├── Load config, check QMD availability
  └── Ensure QMD collections exist for configured skill directories

before_agent_start
  ├── Discover project skills from <cwd>/.pi/skills/
  ├── Query QMD with user prompt against global skill collections
  ├── Combine: project skills (first) + ranked global skills
  ├── Stability cache: skip rewrite if top-N ranked skills unchanged
  └── Rewrite <available_skills> block in system prompt

session_shutdown
  └── Clean up per-session state
```

**Stability cache:** Compares the top-N ranked global skill names (configurable via `stabilityWindow`, default 5) across turns. If the set is unchanged, reuses the cached results to avoid rewriting the system prompt unnecessarily — preventing KV cache thrashing.

**Graceful degradation:** On any QMD failure (spawn error, timeout, parse error, empty results), the extension falls back to returning the original system prompt unchanged — all skills remain available.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent installed
- [QMD](https://github.com/qmd-remote/qmd) CLI installed and available on `PATH`

## Installation

Install directly from GitHub:

```bash
pi install github:dfein38347g/pi-smart-skills
```

Or clone and install locally:

```bash
git clone https://github.com/dfein38347g/pi-smart-skills.git
cd pi-smart-skills
pi install .
```

The extension is declared via the `"pi"` field in `package.json` and loaded automatically by pi's jiti loader — no build step required.

## QMD setup

The extension creates and updates QMD collections at session start. For best performance with many skills, set up a system cron job to periodically re-index:

```bash
# Re-index every 5 minutes
*/5 * * * * qmd update
```

Without a cron job, collections are only updated when you start a new pi session.

## Configuration

Optional config file at `~/.pi/agent/pi-smart-skills.json` (or `$PI_CODING_AGENT_DIR/pi-smart-skills.json`):

```json
{
  "maxResults": 10,
  "promptCharLimit": 4000,
  "stabilityWindow": 5,
  "qmdTimeoutMs": 5000,
  "skillDirectories": ["~/.pi/agent/skills"]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `maxResults` | `10` | Maximum skills returned by QMD per query |
| `promptCharLimit` | `4000` | Maximum user prompt length (chars) before filtering is skipped entirely |
| `stabilityWindow` | `5` | Number of top-ranked skills compared across turns for the stability cache |
| `qmdTimeoutMs` | `5000` | Timeout (ms) for QMD CLI subprocess calls |
| `skillDirectories` | `[~/.pi/agent/skills]` | Directories containing global skill definitions |

All fields are optional — config is merged over defaults via spread.

## Skill file format

Skills are discovered as `SKILL.md` files. Each skill directory should contain a single `SKILL.md` with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does and when to use it
---

Skill instructions here...
```

The extension parses the `name` and `description` fields from the frontmatter to build the `<available_skills>` block — matching vanilla pi's format (name + description + location only).

# pi-smart-skills

[pi](https://github.com/earendil-works/pi) extension that uses [QMD](https://github.com/qmd-remote/qmd) hybrid search to lazily inject the skills most relevant to the current prompt — by rewriting the `<available_skills>` block in the system prompt (pi standalone), or, in runtimes that keep their skill catalog outside the system prompt (dsh via pi2dsh publishes it as a user message), by injecting a compact "most relevant skills" custom message beside the turn's user message — keeping context lean while always including project-local skills.

## What it does

When you have many skills installed, injecting all of them into every session wastes tokens and slows inference. This extension filters global skills by semantic relevance to your prompt, while always including project-local skills.

**Three skill sources:**

| Source | Location | Behavior |
|--------|----------|----------|
| **Project skills** | `<cwd>/.pi/skills/*/SKILL.md` | Always included (name + description), bypass QMD entirely |
| **Global skills** | Configurable directories (default `~/.pi/agent/skills/`) | Filtered by QMD semantic relevance to user prompt |
| **Package skills** | Auto-discovered from installed pi packages (`npm:`, `git:`) | Filtered by QMD — discovered at session start from `settings.json` |

Project skills are deduplicated against global skills by name — if a skill exists in both locations, the project-local version wins.

**Package skill discovery:** At session start, the extension recursively scans `~/.pi/agent/npm/node_modules/` and `~/.pi/agent/git/` for any `skills/` directory containing valid `SKILL.md` files. Each `SKILL.md` is validated — it must have YAML frontmatter with both `name` and `description` fields. Config template skills under `configs/` are skipped. Discovered directories are deduplicated against `skillDirectories` by resolved path and indexed into QMD collections automatically. No manual configuration needed.

## How it works

```
session_start
  ├── Load config, check QMD availability
  ├── Scan node_modules/ and git/ for skills/ directories
  │   ├── Validate SKILL.md frontmatter (name + description required)
  │   ├── Skip config templates under configs/
  │   └── Deduplicate against skillDirectories by resolved path
  └── Ensure QMD collections exist for all skill directories

before_agent_start
  ├── Skip (prompt unchanged) when the prompt has fewer than minPromptWords
  │   words (default 2 — one word or fewer: "continue", "ok", ...)
  ├── Decide the injection mode (injectionMode; "auto" = block present?):
  │   ├─ rewrite: discover project skills from <cwd>/.pi/skills/,
  │   │   query QMD with the user prompt against global skill collections,
  │   │   combine (project skills first) + ranked global skills,
  │   │   stability-cache the top-N, rewrite the <available_skills> block
  │   └─ message (dsh-style runtimes): rank skills via QMD, resolve each
  │       name to its SKILL.md name + description from disk, and return a
  │       "most relevant skills" custom message for this turn (pi2dsh
  │       enters it beside the user message)
  └── Return the replacement prompt (rewrite) or the custom message

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
  "skillDirectories": ["~/.pi/agent/skills"],
  "minPromptWords": 2,
  "injectionMode": "auto",
  "qmdStorePath": null
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `maxResults` | `10` | Maximum skills returned by QMD per query |
| `promptCharLimit` | `4000` | Maximum user prompt length (chars) before filtering is skipped entirely |
| `stabilityWindow` | `5` | Number of top-ranked skills compared across turns for the stability cache |
| `qmdTimeoutMs` | `5000` | Timeout (ms) for QMD CLI subprocess calls |
| `skillDirectories` | `[~/.pi/agent/skills]` | Directories containing global skill definitions — merged with auto-discovered package dirs |
| `minPromptWords` | `2` | User prompts with fewer than this many whitespace-separated words skip the skills search/injection entirely (i.e. one word or fewer: "continue", "ok", …). A run of CJK text without internal spaces counts as a single word. |
| `injectionMode` | `"auto"` | `"auto"`: rewrite the system prompt's `<available_skills>` block when present (pi standalone); otherwise inject a "most relevant skills" custom message for the turn (dsh via pi2dsh). `"rewrite"` / `"message"` force one side. |
| `qmdStorePath` | npm-global install | Where to import qmd's `store.js` (or its dist dir) in-process — `~` expands. Set for a profile whose runtime Node ABI differs from the machine-wide qmd build (e.g. dsh-web) to point at a per-runtime qmd copy; the `PI_SMART_SKILLS_QMD_STORE` env var overrides this. |

All fields are optional — config is merged over defaults via spread. Package skill directories are discovered automatically and merged with `skillDirectories` — duplicates are deduplicated by resolved path.

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

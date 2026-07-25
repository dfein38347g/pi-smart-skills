# pi-smart-skills

Pi extension that dynamically filters the `<available_skills>` block in the system prompt using QMD semantic search.

## Architecture

Single-file extension: `src/extension.ts` → re-exported by `index.ts`.

**Two skill sources:**
- **Project skills** (`<cwd>/.pi/skills/*/SKILL.md`) — always injected in full, bypass QMD entirely
- **Global skills** (`~/.pi/agent/skills/` by default) — filtered by QMD semantic relevance to user prompt

**Flow:** `session_start` → load config, check QMD, ensure collections exist → `before_agent_start` → discover project skills, query QMD, rewrite `<available_skills>` block → `session_shutdown` → cleanup state.

**Session state** is keyed by `ctx.sessionManager.getSessionId()` — NOT by `ctx` object identity (pi creates a new context per event).

## Dependencies

- **QMD** CLI tool — required for global skill search. Extension degrades gracefully if unavailable (injects all skills).
- **`@earendil-works/pi-coding-agent`** — peer dependency for types. Not installed locally; resolved from global pi installation at `~/.npm-global/lib/node_modules/`.

## Commands

```bash
npx tsc --noEmit   # typecheck — two pre-existing errors are expected (index.ts .ts extension import, missing pi types)
```

No build step, no test suite, no lint. The extension is loaded directly by pi as an ESM module.

## Configuration

Config file: `~/.pi/agent/pi-smart-skills.json` (or `$PI_CODING_AGENT_DIR/pi-smart-skills.json`)

```json
{
  "maxResults": 10,
  "promptCharLimit": 4000,
  "stabilityWindow": 5,
  "qmdTimeoutMs": 5000,
  "skillDirectories": ["~/.pi/agent/skills"]
}
```

All fields optional — defaults are sensible. Config is merged over `DEFAULT_CONFIG` via spread.

## QMD Management

The extension creates/updates QMD collections at `session_start` but does **not** run a cron timer for periodic updates. Users manage `qmd update` via system cron:

```bash
# Example: re-index every 5 minutes
*/5 * * * * qmd update
```

## Gotchas

- `ctx` is recreated per event — always key session state by `ctx.sessionManager.getSessionId()`
- QMD output parsing tries JSON first, then regex fallback — fragile on QMD version changes
- YAML frontmatter parser handles single-line values and block scalars (`|`/`>`) but not nested YAML
- Project skills are deduplicated against global skills by name (project-local wins)
- `index.ts` has a `.ts` extension import — TS error is expected and harmless

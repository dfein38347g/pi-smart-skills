# pi-smart-skills

Pi extension that dynamically filters the `<available_skills>` block in the system prompt using QMD semantic search.

## Architecture

Single-file extension: `src/extension.ts` → re-exported by `index.ts`.

**Three skill sources:**
- **Project skills** (`<cwd>/.pi/skills/*/SKILL.md`) — always injected in full, bypass QMD entirely
- **Global skills** (`~/.pi/agent/skills/` by default) — filtered by QMD semantic relevance to user prompt
- **Package skills** — auto-discovered at `session_start` by recursively scanning `~/.pi/agent/npm/node_modules/` and `~/.pi/agent/git/` for `skills/` directories containing valid `SKILL.md` files (must have YAML frontmatter with both `name` and `description`). Config templates under `configs/` are skipped. Deduplicated against `skillDirectories` by resolved realpath.

**Flow:** `session_start` → load config, dynamically import QMD's store.js, open DB in-process, scan for package skill dirs, ensure collections exist via programmatic API → `before_agent_start` → discover project skills, call `structuredSearch` (lex+vec) in-process across all skill collections, rewrite `<available_skills>` block → `session_shutdown` → cleanup state.

**Session state** is keyed by `ctx.sessionManager.getSessionId()` — NOT by `ctx` object identity (pi creates a new context per event).

**Key design decision:** All QMD operations use the in-process TypeScript API (`store.js`'s `createStore`, `structuredSearch`, etc.) via dynamic `import()` of absolute paths under `~/.npm-global/lib/node_modules/@tobilu/qmd/dist/`. Zero QMD CLI process spawns. The extension imports QMD's own `structuredSearch` function and calls it directly with `{type: "lex"}` and `{type: "vec"}` queries across all 6 skill collections in one call, skipping expansion and reranking. If vector search fails (remote endpoint down), falls back to BM25-only.

## Dependencies

- **QMD** package (`@tobilu/qmd`) installed globally — imported at runtime via `~/.npm-global/lib/node_modules/@tobilu/qmd/dist/store.js`. Extension degrades gracefully if unavailable (injects all skills).
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

All fields optional — defaults are sensible. `qmdTimeoutMs` is retained for config backward compat but no longer used (no CLI spawns to time out). Config is merged over `DEFAULT_CONFIG` via spread. Package skill directories are discovered automatically and merged with `skillDirectories`.

## QMD Management

The extension manages QMD collections programmatically at `session_start` (uses `addCollection`/`removeCollection` from store.js + collections.js, no CLI). It does **not** run a cron timer for periodic updates. Users manage `qmd update` via system cron:

```bash
# Example: re-index every 5 minutes
*/5 * * * * qmd update
```

## Gotchas

- `ctx` is recreated per event — always key session state by `ctx.sessionManager.getSessionId()`
- QMD is imported via absolute paths under `~/.npm-global/` — breaks if npm prefix changes
- YAML frontmatter parser handles single-line values and block scalars (`|`/`>`) but not nested YAML
- Project skills are deduplicated against global skills by name (project-local wins)
- `index.ts` has a `.ts` extension import — TS error is expected and harmless
- `parseSkillFile` is defined after `scanForSkillsDirs` in the source — works at runtime because it's a `function` declaration (hoisted), but moving it around will break nothing
- Dynamic imports of QMD's store.js load its native deps (better-sqlite3, llama.cpp bindings) into pi's process — if any native module fails, `initQmdStore` returns false and all skills are injected
- `structuredSearch` tries `vec:` first; if remote endpoint is unreachable, catches "fetch"/"connect" errors and retries with `lex:` only

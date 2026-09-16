# pi-smart-skills

Pi extension that uses QMD semantic search to deliver the skills most relevant to the current prompt — either by rewriting the `<available_skills>` block in the system prompt (pi standalone) or, for runtimes that keep their skill catalog elsewhere (dsh via pi2dsh publishes it as a user message), by injecting a per-turn "most relevant skills" custom message beside the user message.

## Architecture

Single-file extension: `src/extension.ts` → re-exported by `index.ts`.

**Three skill sources:**
- **Project skills** (`<cwd>/.pi/skills/*/SKILL.md`) — always injected in full, bypass QMD entirely
- **Global skills** (`~/.pi/agent/skills/` by default) — filtered by QMD semantic relevance to user prompt
- **Package skills** — auto-discovered at `session_start` by recursively scanning `~/.pi/agent/npm/node_modules/` and `~/.pi/agent/git/` for `skills/` directories containing valid `SKILL.md` files (must have YAML frontmatter with both `name` and `description`). Config templates under `configs/` are skipped. Deduplicated against `skillDirectories` by resolved realpath.

**Flow:** `session_start` → load config, dynamically import QMD's store.js, open DB in-process, scan for package skill dirs, index the configured skill directories on disk (`catalogTotal` — name → SKILL.md metadata), ensure collections exist via programmatic API → `before_agent_start` → skip when the prompt has fewer than `minPromptWords` words (default 2 — i.e. one word or fewer, e.g. `continue`, `ok` — no QMD call, nothing injected), otherwise decide the delivery mode per `injectionMode` — **"rewrite"** (the `"auto"` default when the prompt carries an `<available_skills>` block): discover project skills, call `structuredSearch` (lex+vec) in-process across all skill collections, stability-cache the top-N, rewrite the block; or **"message"** (dsh-style runtimes, no block in the prompt): rank the skills, resolve each name to its on-disk SKILL.md metadata, return a `{ message: { customType, content } }` custom message that the host enters into that turn → `session_shutdown` → cleanup state.

**Session state** is keyed by `ctx.sessionManager.getSessionId()` — NOT by `ctx` object identity (pi creates a new context per event).

**Key design decision:** All QMD operations use the in-process TypeScript API (`store.js`'s `createStore`, `structuredSearch`, etc.) via dynamic `import()` of a path resolved by `resolveQmdStorePath()` — env `PI_SMART_SKILLS_QMD_STORE` > config `qmdStorePath` > the npm-global default under `~/.npm-global/lib/node_modules/@tobilu/qmd/dist/`. Zero QMD CLI process spawns. The extension imports QMD's own `structuredSearch` function and calls it directly with `{type: "lex"}` and `{type: "vec"}` queries across all 6 skill collections in one call, skipping expansion and reranking. If vector search fails (remote endpoint down), falls back to BM25-only.

## Dependencies

- **QMD** package (`@tobilu/qmd`) installed globally — imported at runtime from the path `resolveQmdStorePath()` returns (npm-global default; `qmdStorePath` / `PI_SMART_SKILLS_QMD_STORE` point a profile with a different runtime Node ABI at a per-runtime copy, e.g. `~/.dsh/vendor/qmd-26/`). Extension degrades gracefully if unavailable (all skills injected; the message path skips rather than injects everything, so it stays silent).
- **`@earendil-works/pi-coding-agent`** — peer dependency for types. Not installed locally; resolved from global pi installation at `~/.npm-global/lib/node_modules/`.

## Commands

```bash
npx tsc --noEmit   # typecheck — two pre-existing errors are expected (index.ts .ts extension import, missing pi types)
node test/estimate-tokens.mjs   # checks the token estimator behind the search-trigger guard (transpiles src/extension.ts with the repo's typescript devDep)
node test/dsh-injection.mjs     # checks the pure helpers of the message-injection path (same transpile pattern)
```

No build step, no lint. The extension is loaded directly by pi as an ESM module; `test/` is a plain Node script (no test runner).

## Configuration

Config file: `~/.pi/agent/pi-smart-skills.json` (or `$PI_CODING_AGENT_DIR/pi-smart-skills.json`)

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

All fields optional — defaults are sensible. `minPromptWords` is the trigger guard: user prompts with fewer than that many whitespace-separated words (default 2 — one word or fewer: `continue`, `ok`) skip the skills search/injection entirely. `injectionMode` (`"auto"` default) picks prompt-block rewrite (pi standalone) vs. per-turn custom message (dsh via pi2dsh); `"rewrite"`/`"message"` force either. `qmdStorePath` (or env `PI_SMART_SKILLS_QMD_STORE`) relocates the in-process qmd import for runtimes whose Node ABI differs from the global build. `qmdTimeoutMs` is retained for config backward compat but no longer used (no CLI spawns to time out). Config is merged over `DEFAULT_CONFIG` via spread. Package skill directories are discovered automatically and merged with `skillDirectories`.

## QMD Management

The extension manages QMD collections programmatically at `session_start` (uses `addCollection`/`removeCollection` from store.js + collections.js, no CLI). It does **not** run a cron timer for periodic updates. Users manage `qmd update` via system cron:

```bash
# Example: re-index every 5 minutes
*/5 * * * * qmd update
```

## Gotchas

- `ctx` is recreated per event — always key session state by `ctx.sessionManager.getSessionId()`
- QMD is imported via the path `resolveQmdStorePath()` resolves (npm-global by default) — breaks if the npm prefix changes; point `qmdStorePath` / `PI_SMART_SKILLS_QMD_STORE` at a per-runtime qmd copy when the runtime's Node ABI differs from the global build (dsh-web: ABI 147 vs. hermes node 22's 127; a per-runtime copy lives at `~/.dsh/vendor/qmd-26/`)
- YAML frontmatter parser handles single-line values and block scalars (`|`/`>`) but not nested YAML
- Project skills are deduplicated against global skills by name (project-local wins)
- `index.ts` has a `.ts` extension import — TS error is expected and harmless
- `parseSkillFile` is defined after `scanForSkillsDirs` in the source — works at runtime because it's a `function` declaration (hoisted), but moving it around will break nothing
- Dynamic imports of QMD's store.js load its native deps (better-sqlite3, llama.cpp bindings) into pi's process — if any native module fails, `initQmdStore` returns false and all skills are injected
- `structuredSearch` tries `vec:` first; if remote endpoint is unreachable, catches "fetch"/"connect" errors and retries with `lex:` only

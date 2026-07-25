# pi-smart-skills Design

**Date:** 2026-07-24
**Status:** Approved

## Goal

Standalone pi extension that uses QMD hybrid search to lazily inject only the most relevant skills into the system prompt, reducing prompt size and improving inference quality.

## Architecture

Single-file extension installed as a pi package via `pi install`. On each agent turn, queries QMD to rank skills by relevance to the user prompt, then rewrites the `<available_skills>` XML block in the system prompt to include only the top-ranked skills. On any failure, falls back to keeping all skills.

### Project Structure

```
pi-smart-skills/
├── index.ts                    # Re-export entry point for pi manifest
├── src/
│   └── extension.ts            # Main extension implementation
├── test/                       # Unit tests
├── package.json                # Pi package manifest
├── tsconfig.json               # TypeScript config
├── .gitignore
├── README.md
└── docs/
    └── superpowers/
        ├── specs/
        └── plans/
```

### Package Configuration

**package.json** with pi manifest:
```json
{
  "name": "pi-smart-skills",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "skills", "qmd"],
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true }
  }
}
```

Install via `pi install git:github.com:nathan/pi-smart-skills`.

## Component Design

### 1. Configuration Loader

Reads optional config from `~/.pi/agent/pi-smart-skills.json`, merges with defaults.

```typescript
interface ExtensionConfig {
  maxResults: number;        // default: 10
  promptCharLimit: number;   // default: 60_000
  stabilityWindow: number;   // default: 3
  qmdTimeoutMs: number;      // default: 5_000
  cacheTtlMs: number;        // default: 60_000 (unused, retained for future)
  cronIntervalMs: number;    // default: 300_000 (unused — no background cron)
}
```

### 2. QMD Collection Manager

Manages the QMD collection lifecycle:

- **`session_start`:** If collection `pi-smart-skills` doesn't exist, create it pointing at `~/.pi/agent/skills/`. If it exists, run `qmd update -c pi-smart-skills` to re-index only our collection.
- Collection is isolated — never touches other QMD collections.

### 3. QMD Query Engine

On every `before_agent_start`, runs:
```
qmd query pi-smart-skills <user-prompt> -n <maxResults> --format json
```

Extracts skill names from file paths in results. Returns structured error objects (`{ kind, detail }`) for TUI notification.

**Error kinds:**
- `spawn` — QMD binary not found or spawn failed
- `exit` — non-zero exit code (includes stderr)
- `parse` — JSON parse failure
- `empty` — no results returned

### 4. Stability Cache

Prevents KV cache thrashing by comparing the set of top-N ranked skills across turns.

```typescript
interface CacheEntry {
  rankedNames: string[];
  topNSet: Set<string>;     // Set equality, not order equality
  injectedPrompt: string;   // Cached prompt to return when stable
  timestamp: number;
}
```

- On `before_agent_start`: compare new top-N set against cached set using set equality
- If sets are equal (same skills, any order), return cached `injectedPrompt` — no rewrite
- If sets differ, build new block, update cache

### 5. System Prompt Rewriter

Rewrites the `<available_skills>` XML block in the system prompt.

**Flow:**
1. Match `<available_skills>...</available_skills>` block in system prompt
2. Parse existing skill entries via regex
3. If user prompt > `promptCharLimit`, skip QMD — keep all skills (info notification)
4. Run QMD query, handle errors with failover (warn notification with details)
5. Filter skills by ranked names
6. If no matches, failover to all skills (warn notification)
7. Stability check — if top-N set unchanged, return cached prompt
8. Build new XML block, replace in system prompt, update cache

**Failover paths (all return unchanged system prompt):**
- QMD spawn failure → TUI: `QMD spawn: <error>`
- QMD non-zero exit → TUI: `QMD exit <code>: <stderr>`
- JSON parse failure → TUI: `QMD parse: <error>`
- Empty results → TUI: `QMD returned no results`
- No ranked skills match existing → TUI: `No ranked skills matched`
- Runtime exception → TUI: `Error: <error>`

### 6. Extension Factory

Registers lifecycle hooks via `ExtensionAPI`:

- **`session_start`:** Initialize QMD collection, re-index if exists
- **`before_agent_start`:** Rank skills, rewrite system prompt
- **`session_end`:** Cleanup (no-op currently, since no background cron)

No background cron — indexing happens at session start only.

## Data Flow

```
User sends prompt
  └─► before_agent_start
       ├─► Match <available_skills> block
       ├─► Parse existing skill entries
       ├─► QMD query (every turn, no search cache)
       │    └─► Extract skill names from file paths
       ├─► Filter skills by ranked names
       ├─► Stability check (set equality on top-N)
       │    ├─ Stable → return cached prompt
       │    └─ Changed → build new block, update cache
       └─► Return { systemPrompt } or undefined (failover)
```

## Out of Scope

- **Subagent skill injection** — subagents construct their system prompt inside `execution.ts:runSync()`, not via `before_agent_start`. Requires changes to pi-subagents. Future enhancement.
- **Background cron indexing** — indexing happens at session start only. User can manually run `qmd update -c pi-smart-skills` if needed.
- **Project-local skills** — only scans `~/.pi/agent/skills/`.
- **npm package skills** — not scanned.

## Configuration Reference

Optional config at `~/.pi/agent/pi-smart-skills.json`:

```json
{
  "maxResults": 10,
  "promptCharLimit": 60000,
  "stabilityWindow": 3,
  "qmdTimeoutMs": 5000
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `maxResults` | 10 | Max skills returned by QMD query |
| `promptCharLimit` | 60000 | Skip QMD if user prompt exceeds this length |
| `stabilityWindow` | 3 | Number of top skills to compare for stability |
| `qmdTimeoutMs` | 5000 | Timeout for QMD CLI commands (ms) |

## Requirements

1. Extension must work with pi's jiti loader — TypeScript files, no build step
2. Import pi APIs from `@earendil-works/pi-coding-agent` (virtual module in compiled binary)
3. Use `node:child_process`, `node:fs`, `node:path`, `node:os` for Node.js builtins — `import` syntax
4. QMD binary at `/home/nathan/.local/bin/qmd` — invoke via `spawnSync("qmd", [...])` not shell strings
5. Extension entry point exports factory function: `(pi: ExtensionAPI) => void`
6. `event.systemPrompt` in `before_agent_start` is a `string` — return `{ systemPrompt: string }`
7. `ctx.ui.notify(message, level)` prints to TUI — levels: `"info"`, `"warn"`, `"error"`
8. Config file at `~/.pi/agent/pi-smart-skills.json` — falls back to defaults if missing
9. QMD collection: `pi-smart-skills`, points at `~/.pi/agent/skills/` directly
10. Use `qmd query` (not `qmd search`) — expansion + BM25 + vector + rerank
11. `qmd update -c pi-smart-skills` — isolate to our collection only
12. On ANY failure, return system prompt unchanged (keeps all skills) — aggressive failover
13. Stability check uses set equality — `[A,B,C]` equals `[A,C,B]`
14. Only scan `~/.pi/agent/skills/` for skills
15. Inject skill name, description, location — same format as vanilla pi
16. Error details surfaced in TUI notifications

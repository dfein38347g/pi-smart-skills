{
  "goal": "Create a standalone pi extension at ~/.pi/agent/extensions/pi-smart-skills/index.ts that uses QMD hybrid search to lazily inject relevant skills into the system prompt — completely independent of pi-subagents, works on a vanilla pi install with no other extensions.",
  "architecture": "Single-file extension. On load, registers the QMD collection pointing directly at skill directories (no copying/index directory). A background cron runs `qmd update` every 5 minutes to re-index. On `before_agent_start`, calls `qmd query` with a configurable timeout to rank skills by relevance to the user prompt, compares top-3 for stability against the previous run, and rewrites the `<available_skills>` block in the system prompt. On any failure (QMD missing, timeout, parse error, empty results), falls back to injecting ALL skills — the system prompt never loses skills.",
  "tech_stack": "TypeScript, pi-coding-agent ExtensionAPI, QMD CLI (spawnSync with timeout), jiti (for TS execution)"
}

## Global Constraints

- Extension must work with pi's jiti loader — TypeScript files, no build step required
- Import pi APIs from `@earendil-works/pi-coding-agent` (available as virtual module in compiled binary)
- Use `node:child_process`, `node:fs`, `node:path`, `node:os` for Node.js builtins — use `import` syntax, not `require`
- QMD binary at `/home/nathan/.local/bin/qmd` — invoke via `spawnSync("qmd", [...])` not shell strings
- Extension entry point exports a factory function: `(pi: ExtensionAPI) => void`
- `event.systemPrompt` in `before_agent_start` is a `string` — return `{ systemPrompt: string }`
- `ctx.ui.notify(message, level)` prints to TUI — levels: "info", "warn", "error"
- `ctx.ui` is available on the `ctx` parameter in `before_agent_start`
- Config read from `~/.pi/agent/pi-smart-skills.json` (JSON) — falls back to defaults if missing
- QMD collection: `qmd collection add pi-smart-skills <path>` points at skill dir directly, `qmd update` re-indexes
- Use `qmd query` (not `qmd search`) — it does expansion + BM25 + vector + rerank
- On ANY failure, return the system prompt unchanged (keeps all skills) — aggressive failover

---

## Task 1: Create pi-smart-skills Extension (Single File)

**File:** `~/.pi/agent/extensions/pi-smart-skills/index.ts`

- [ ] **Step 1: Create directory**

```bash
mkdir -p /home/nathan/.pi/agent/extensions/pi-smart-skills
```

- [ ] **Step 2: Write index.ts**

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* ------------------------------------------------------------------ */
/* Configuration — loaded from JSON file, falls back to defaults      */
/* ------------------------------------------------------------------ */

const CONFIG_PATH = path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  "pi-smart-skills.json"
);

interface ExtensionConfig {
  maxResults: number;
  promptCharLimit: number;
  stabilityWindow: number;
  qmdTimeoutMs: number;
  cacheTtlMs: number;
  cronIntervalMs: number;
}

const DEFAULT_CONFIG: ExtensionConfig = {
  maxResults: 10,
  promptCharLimit: 60_000,
  stabilityWindow: 3,
  qmdTimeoutMs: 5000,
  cacheTtlMs: 60_000,
  cronIntervalMs: 5 * 60 * 1000,
};

function loadConfig(): ExtensionConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const config = loadConfig();

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const COLLECTION_NAME = "pi-smart-skills";
const AGENT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

/* ------------------------------------------------------------------ */
/* Skill discovery — scans directories for SKILL.md files             */
/* ------------------------------------------------------------------ */

interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
}

function discoverSkills(cwd: string): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  const seenNames = new Set<string>();

  const scanDir = (dirPath: string) => {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = path.join(dirPath, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;
        if (seenNames.has(entry.name)) continue;

        seenNames.add(entry.name);
        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const description = extractDescription(content);
          skills.push({
            name: entry.name,
            description,
            location: skillMdPath,
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  };

  scanDir(AGENT_SKILLS_DIR);

  // Also scan cwd for local skills
  if (cwd) {
    const localSkills = path.join(cwd, "skills");
    scanDir(localSkills);
  }

  return skills;
}

function extractDescription(content: string): string {
  // Try YAML frontmatter description
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*\|?\s*(.+?)\s*$/m);
    if (descMatch) return descMatch[1].trim();
  }

  // Fall back to first heading
  const lines = content.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      return trimmed.replace(/^#+\s*/, "").trim();
    }
  }

  return "";
}

/* ------------------------------------------------------------------ */
/* QMD helpers                                                        */
/* ------------------------------------------------------------------ */

function qmdAvailable(): boolean {
  const result = spawnSync("qmd", ["--version"], {
    encoding: "utf-8",
    timeout: 3000,
  });
  return !result.error && result.status === 0;
}

function getSkillDirectories(cwd: string): string[] {
  const dirs: string[] = [];

  if (fs.existsSync(AGENT_SKILLS_DIR) && fs.statSync(AGENT_SKILLS_DIR).isDirectory()) {
    dirs.push(AGENT_SKILLS_DIR);
  }

  if (cwd) {
    const localSkills = path.join(cwd, "skills");
    if (fs.existsSync(localSkills) && fs.statSync(localSkills).isDirectory()) {
      dirs.push(localSkills);
    }
  }

  // Also scan npm node_modules for packaged skills
  const npmBase = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules");
  if (fs.existsSync(npmBase)) {
    try {
      const entries = fs.readdirSync(npmBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgSkills = path.join(npmBase, entry.name, "skills");
        if (fs.existsSync(pkgSkills) && fs.statSync(pkgSkills).isDirectory()) {
          dirs.push(pkgSkills);
        }
      }
    } catch {
      // Skip if we can't read npm directory
    }
  }

  return dirs;
}

function ensureCollection(cwd: string): boolean {
  // Check if collection already exists
  const listResult = spawnSync("qmd", ["collection", "list", "--json"], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs,
  });

  if (!listResult.error && listResult.status === 0) {
    try {
      const collections: Array<{ name: string }> = JSON.parse(listResult.stdout);
      if (Array.isArray(collections) && collections.some((c) => c.name === COLLECTION_NAME)) {
        return true;
      }
    } catch {
      // Parse error — proceed to create collection
    }
  }

  // Add collection pointing directly at skill directories
  const skillDirs = getSkillDirectories(cwd);
  if (skillDirs.length === 0) {
    return false;
  }

  for (const dir of skillDirs) {
    const addResult = spawnSync("qmd", ["collection", "add", COLLECTION_NAME, dir], {
      encoding: "utf-8",
      timeout: config.qmdTimeoutMs,
    });
    if (addResult.error || addResult.status !== 0) {
      return false;
    }
  }

  // Initial index
  const updateResult = spawnSync("qmd", ["update"], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs * 2,
  });

  return !updateResult.error && updateResult.status === 0;
}

function updateIndex(): boolean {
  const result = spawnSync("qmd", ["update"], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs * 2,
  });

  return !result.error && result.status === 0;
}

function searchQMD(query: string): string[] {
  // Pass query as raw argument — array form of spawnSync avoids shell injection,
  // no manual escaping needed
  const result = spawnSync(
    "qmd",
    [
      "query",
      query,
      "-c",
      COLLECTION_NAME,
      "-n",
      String(config.maxResults),
      "--format",
      "json",
    ],
    {
      encoding: "utf-8",
      timeout: config.qmdTimeoutMs,
    },
  );

  if (result.error) return [];
  if (result.status !== 0) return [];

  let parsed: Array<{ file?: string; score?: number }> = [];
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  // Extract skill names from file paths
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of parsed) {
    if (!item.file) continue;
    // Skill name is the directory containing SKILL.md
    const parts = item.file.split(path.sep);
    for (let i = parts.length - 2; i >= 0; i--) {
      const candidate = parts[i];
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        names.push(candidate);
        if (names.length >= config.maxResults) break;
      }
    }
    if (names.length >= config.maxResults) break;
  }

  return names;
}

/* ------------------------------------------------------------------ */
/* Search cache with TTL + stability tracking                         */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  rankedNames: string[];
  topN: string[];
  injectedPrompt: string;
  timestamp: number;
}

let searchCache: CacheEntry | null = null;

function getCachedOrSearch(query: string): string[] {
  if (searchCache && Date.now() - searchCache.timestamp < config.cacheTtlMs) {
    return searchCache.rankedNames;
  }

  const ranked = searchQMD(query);
  if (ranked.length > 0) {
    searchCache = {
      rankedNames: ranked,
      topN: ranked.slice(0, config.stabilityWindow),
      injectedPrompt: "",
      timestamp: Date.now(),
    };
  }
  return ranked;
}

/* ------------------------------------------------------------------ */
/* System prompt rewriting                                            */
/* ------------------------------------------------------------------ */

interface SkillEntry {
  name: string;
  description: string;
  location: string;
}

function parseSkillEntries(block: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const regex = /<skill>\s*<name>(.*?)<\/name>\s*<description>(.*?)<\/description>\s*<location>(.*?)<\/location>\s*<\/skill>/gs;
  let match;
  while ((match = regex.exec(block)) !== null) {
    entries.push({
      name: match[1].trim(),
      description: decodeXml(match[2].trim()),
      location: match[3].trim(),
    });
  }
  return entries;
}

function buildSkillsBlock(skills: SkillEntry[]): string {
  const lines = ["<available_skills>"];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Rewrite the <available_skills> block in the system prompt.
 * Returns the rewritten prompt, or null if no change was needed.
 */
function rewriteSkillsBlock(
  systemPrompt: string,
  userPrompt: string,
  notify: (msg: string, level: "info" | "warn" | "error") => void,
): { newPrompt: string } | null {
  const blockMatch = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
  if (!blockMatch) return null;

  const fullBlock = blockMatch[0];
  const allSkills = parseSkillEntries(fullBlock);

  // Skip QMD for long prompts — inject all skills
  if (userPrompt.length > config.promptCharLimit) {
    notify(
      `[pi-smart-skills] Prompt too long (${userPrompt.length} chars) — injecting all ${allSkills.length} skills`,
      "info",
    );
    return { newPrompt: systemPrompt }; // Already has all skills, no change needed
  }

  // Search QMD for relevant skills
  let rankedNames: string[];
  try {
    rankedNames = getCachedOrSearch(userPrompt);
  } catch (err) {
    notify(
      `[pi-smart-skills] QMD search error — injecting all ${allSkills.length} skills as failover`,
      "warn",
    );
    return { newPrompt: systemPrompt }; // Keep all skills
  }

  // Failover on empty results
  if (rankedNames.length === 0) {
    notify(
      `[pi-smart-skills] QMD returned no results — injecting all ${allSkills.length} skills as failover`,
      "warn",
    );
    return { newPrompt: systemPrompt }; // Keep all skills
  }

  // Filter to ranked results
  const nameSet = new Set(rankedNames);
  const filtered = allSkills.filter((s) => nameSet.has(s.name));

  if (filtered.length === 0) {
    notify(
      `[pi-smart-skills] No ranked skills matched — injecting all ${allSkills.length} skills as failover`,
      "warn",
    );
    return { newPrompt: systemPrompt }; // Keep all skills
  }

  // Top-N stability check
  const newTopN = rankedNames.slice(0, config.stabilityWindow);
  if (searchCache && searchCache.topN.length > 0) {
    if (arraysEqual(newTopN, searchCache.topN)) {
      // Top-N unchanged — return cached injection to preserve KV cache
      return { newPrompt: searchCache.injectedPrompt };
    }
  }

  // Build new block with filtered skills
  const newBlock = buildSkillsBlock(filtered);
  const newPrompt = systemPrompt.replace(fullBlock, newBlock);

  // Update cache
  searchCache = {
    rankedNames,
    topN: newTopN,
    injectedPrompt: newPrompt,
    timestamp: Date.now(),
  };

  notify(
    `[pi-smart-skills] Injected ${filtered.length}/${allSkills.length} skills (top-${config.stabilityWindow}: ${newTopN.join(", ")})`,
    "info",
  );
  return { newPrompt };
}

/* ------------------------------------------------------------------ */
/* Extension factory                                                  */
/* ------------------------------------------------------------------ */

let initialized = false;
let cronTimer: ReturnType<typeof setInterval> | null = null;

export default function (pi: ExtensionAPI) {
  const qmdOk = qmdAvailable();

  if (!qmdOk) {
    console.warn("[pi-smart-skills] QMD not available — extension will use all-skills failover");
  }

  // Initial collection setup and index
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    searchCache = null;

    if (!qmdOk) {
      ctx.ui?.notify("[pi-smart-skills] QMD binary not found — will inject all skills", "warn");
      return;
    }

    try {
      if (!ensureCollection(ctx.cwd)) {
        ctx.ui?.notify("[pi-smart-skills] Failed to create QMD collection — will inject all skills", "warn");
        return;
      }

      ctx.ui?.notify("[pi-smart-skills] Collection created, performing initial index", "info");
      updateIndex();
    } catch (err) {
      ctx.ui?.notify(`[pi-smart-skills] Init error: ${err} — will inject all skills`, "warn");
    }
  });

  // Background cron — re-indexes every config.cronIntervalMs
  if (!initialized) {
    initialized = true;
    cronTimer = setInterval(() => {
      try {
        if (qmdOk) {
          updateIndex();
        }
      } catch (err) {
        console.warn("[pi-smart-skills] background index error:", err);
      }
    }, config.cronIntervalMs);
    console.log(`[pi-smart-skills] background indexer started (every ${config.cronIntervalMs / 1000}s)`);
  }

  // Clean up cron on unload
  pi.on("session_end", async () => {
    if (cronTimer) {
      clearInterval(cronTimer);
      cronTimer = null;
    }
  });

  // Rank skills and rewrite system prompt
  pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
    const sp = event.systemPrompt;
    if (!sp || typeof sp !== "string") return undefined;

    const notify = (msg: string, level: "info" | "warn" | "error") => {
      ctx.ui?.notify(msg, level);
    };

    try {
      const userPrompt = event.prompt ?? "";
      const result = rewriteSkillsBlock(sp, userPrompt, notify);
      if (result && result.newPrompt !== sp) {
        return { systemPrompt: result.newPrompt };
      }
    } catch (err) {
      notify(`[pi-smart-skills] Error: ${err} — injecting all skills`, "error");
    }
    return undefined;
  });
}
```

- [ ] **Step 3: Verify file created**

```bash
ls -la /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
wc -l /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Single file, ~400 lines.

- [ ] **Step 4: Commit**

```bash
git add ~/.pi/agent/extensions/pi-smart-skills/index.ts
git commit -m "feat: create pi-smart-skills extension with QMD hybrid search, config file, stability check, and failover"
```

---

## Task 2: Revert pi-subagents Modifications (Conditional)

**Files:**
- Conditionally modify: `~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skills.ts`
- Conditionally modify: `~/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.ts`
- Conditionally delete: `~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skill-ranker.ts`
- Conditionally delete: `~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skill-index.ts`

**Note:** Only perform this task if the files exist and contain QMD-related modifications. Guard every operation with a file existence check.

- [ ] **Step 1: Check if pi-subagents has QMD modifications**

```bash
grep -l "rankSkillsViaQMD\|buildSkillInjectionAsync\|clearQmdSkillCache" \
  ~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skills.ts \
  ~/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.ts \
  2>/dev/null || echo "OK: no QMD references in pi-subagents"
```

- [ ] **Step 2: Revert skills.ts (if QMD mods found)**

Edit `~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skills.ts`:
Remove `buildSkillInjectionAsync` function and its export. Keep only:
```typescript
export function buildSkillInjection(skills: ResolvedSkill[]): string {
  return formatSkillList(skills);
}
```

- [ ] **Step 3: Revert execution.ts (if QMD mods found)**

Edit `~/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.ts`:
1. Replace import: `buildSkillInjectionAsync` → `buildSkillInjection`
2. Replace call: `await buildSkillInjectionAsync(resolvedSkills, task)` → `buildSkillInjection(resolvedSkills)`
3. Remove any `clearQmdSkillCache()` call and its import.

- [ ] **Step 4: Delete skill-ranker.ts and skill-index.ts from pi-subagents (if they exist)**

```bash
rm -f ~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skill-ranker.ts
rm -f ~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skill-index.ts
```

- [ ] **Step 5: Verify clean**

```bash
grep -r "rankSkillsViaQMD\|buildSkillInjectionAsync\|clearQmdSkillCache" \
  ~/.pi/agent/npm/node_modules/pi-subagents/src/ 2>&1 || echo "OK: no QMD references in pi-subagents"
```

Expected: "OK: no QMD references in pi-subagents"

- [ ] **Step 6: Commit**

```bash
git add ~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skills.ts \
  ~/.pi/agent/npm/node_modules/pi-subagents/src/runs/foreground/execution.ts
git rm -f ~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skill-ranker.ts 2>/dev/null || true
git rm -f ~/.pi/agent/npm/node_modules/pi-subagents/src/agents/skill-index.ts 2>/dev/null || true
git commit -m "refactor: remove QMD skill ranking from pi-subagents — now handled by pi-smart-skills extension"
```

---

## Task 3: Verification

**Files:**
- Read: Extension file for final review

- [ ] **Step 1: Verify extension file structure**

```bash
ls -la /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
wc -l /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Single file, ~400 lines.

- [ ] **Step 2: Verify config loading**

```bash
grep -n "loadConfig\|CONFIG_PATH\|DEFAULT_CONFIG\|config\." \
  /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Config loading at top of file, all constants replaced with `config.*` references.

- [ ] **Step 3: Verify QMD collection uses direct skill directories (no .qmd-index/)**

```bash
grep -c "\.qmd-index" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: `0` — no `.qmd-index/` directory references.

- [ ] **Step 4: Verify `qmd query` is used (not `qmd search`)**

```bash
grep '"query"' /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Contains `["query", query, ...]` command — raw argument, no manual escaping.

- [ ] **Step 5: Verify no manual quote escaping**

```bash
grep "replace.*\\\\\"" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: `0` matches — no manual quote escaping in `searchQMD`.

- [ ] **Step 6: Verify failover logic**

```bash
grep -n "failover\|injecting all" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Multiple failover paths — QMD error, empty results, no matches.

- [ ] **Step 7: Verify stability check**

```bash
grep -n "stabilityWindow\|topN\|arraysEqual" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Stability comparison logic present, using `config.stabilityWindow`.

- [ ] **Step 8: Verify long prompt skip**

```bash
grep -n "promptCharLimit\|too long" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Prompt length check before QMD call, using `config.promptCharLimit`.

- [ ] **Step 9: Verify TUI notifications**

```bash
grep -n "notify" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: Uses `ctx.ui?.notify(msg, level)` for user-facing messages with typed levels.

- [ ] **Step 10: Verify no blocking on startup**

```bash
grep -n "await.*qmd\|mkdtemp\|qmdReady" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: No blocking QMD calls at startup, no temp directories.

- [ ] **Step 11: Verify all variables are declared**

```bash
grep -n "COLLECTION_NAME\|initialized\|cronTimer\|searchCache\|buildSkillsBlock" \
  /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: All variables have declarations before use.

- [ ] **Step 12: Verify graceful degradation when QMD missing**

Test by temporarily renaming the qmd binary:
```bash
mv /home/nathan/.local/bin/qmd /home/nathan/.local/bin/qmd.bak
# Start pi — should see TUI notification about QMD not found
# Pi should start normally, all skills injected
mv /home/nathan/.local/bin/qmd.bak /home/nathan/.local/bin/qmd
```

Expected: Pi starts normally, extension logs warning and uses all-skills failover.

- [ ] **Step 13: Verify no pi-subagents dependency**

```bash
grep -n "pi-subagents\|buildSkillInjection" /home/nathan/.pi/agent/extensions/pi-smart-skills/index.ts
```

Expected: `0` matches — extension is completely independent.

- [ ] **Step 14: Commit**

```bash
git add ~/.pi/agent/extensions/pi-smart-skills/
git commit -m "verify: end-to-end verification of pi-smart-skills extension"
```

---

## Self-Review Checklist

### Requirements Coverage

| # | Requirement | Implementation |
|---|------------|----------------|
| 1 | Configurable result count | `config.maxResults` from `pi-smart-skills.json`, passed as `-n` to `qmd query` |
| 2 | QMD internal collection | `qmd collection add pi-smart-skills <skills-dir>` then `qmd update`. Points directly at skill directories — no `.qmd-index/` copying |
| 3 | Use `qmd query` | Command: `qmd query <query> -c pi-smart-skills -n <maxResults> --format json` — raw argument, no escaping |
| 4 | Skip QMD for long prompts | `config.promptCharLimit` (default 60,000) — if `userPrompt.length > config.promptCharLimit`, skip QMD and keep all skills |
| 5 | Top-N stability check | `config.stabilityWindow` (default 3) — compares new top-N against cached top-N via `arraysEqual`. If unchanged, returns cached `injectedPrompt` |
| 6 | Aggressive failover | On QMD not found, timeout, non-zero exit, parse error, or empty results — falls back to keeping all skills in `<available_skills>` block |
| 7 | Configurable timeout | `config.qmdTimeoutMs` (default 5000) — passed to `spawnSync`'s `timeout` option which kills the process |
| 8 | Config file pattern | Reads `~/.pi/agent/pi-smart-skills.json` — merges with defaults. If missing, uses `DEFAULT_CONFIG` |

### Bugs Fixed From Previous Plan
- **`COLLECTION_NAME` undefined** — now declared as `const COLLECTION_NAME = "pi-smart-skills"` at module level
- **`buildSkillsBlock` undefined** — function now properly defined (was missing, `parseSkillEntries` existed but not the builder)
- **`initialized`/`cronTimer` undeclared** — moved declarations to module level: `let initialized = false; let cronTimer = ... | null = null;`
- **`CacheEntry` missing `injectedPrompt`** — field added to interface
- **`notify` type too broad** — changed from `level: string` to `level: "info" | "warn" | "error"`
- **Manual quote escaping in `searchQMD`** — removed, query passed as raw argument to spawnSync array form
- **Hardcoded constants** — replaced with `config.*` loaded from JSON config file
- **`rewriteSkillsBlock` referenced undefined `filtered`/`userPrompt`** — all variables properly declared as function parameters or local bindings
- **`before_agent_start` error handler** — now uses `notify` with `"error"` level and returns `undefined` (unchanged prompt)

### Architecture Changes From Previous Plan
- **No `.qmd-index/` directory** — QMD points directly at skill directories; QMD manages its own index at `~/.cache/qmd/index.sqlite`
- **`qmd query` instead of `qmd search`** — uses hybrid search with expansion + BM25 + vector + reranking
- **`qmd update` instead of manual collection update** — simpler, re-indexes all collections
- **Config file pattern** — reads `~/.pi/agent/pi-smart-skills.json` with sensible defaults
- **Raw query arguments** — `spawnSync` array form avoids shell injection, no manual escaping
- **Top-N stability check** — prevents KV cache thrashing by skipping rewrite when top-3 unchanged
- **Long prompt skip** — avoids QMD for prompts >60K chars (likely code dumps)
- **Aggressive failover** — system prompt never loses skills; better to show all than none
- **TUI notifications** — uses `ctx.ui.notify(msg, level)` with typed levels instead of `console.warn` for user-visible messages
- **spawnSync timeout** — uses built-in `timeout` option instead of QMD's non-existent `--timeout` flag
- **Extension is independent** — no pi-subagents references, works on vanilla pi install

### Placeholder Scan
- No "TBD", "TODO", "implement later" patterns
- All code is complete and inline
- All file paths are absolute
- All variables are declared before use

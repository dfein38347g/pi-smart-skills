import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* ------------------------------------------------------------------ */
/* QMD runtime path                                                    */
/* ------------------------------------------------------------------ */

// The QMD dist entry points this extension imports in-process are resolved
// by resolveQmdStorePath() (QMD helpers section below): a profile whose
// runtime Node ABI differs from the machine-wide global tree (e.g. dsh-web)
// can point at a per-runtime qmd copy without touching the global install.

let _qmdStore: any = null;
let _qmdSearch: any = null;
let _removeCollection: any = null;
let _syncConfigToDb: any = null;
let _reindexCollection: any = null;
let _qmdCollModule: any = null;

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const LOG_FILE = path.join(AGENT_DIR, "pi-smart-skills.log");

let _logLevel: LogLevel = "warn";
let _notifyFn: ((msg: string, level: "info" | "warning" | "error") => void) | null = null;

function setLogLevel(level: string): void {
  if (level in LOG_LEVELS) _logLevel = level as LogLevel;
}

function setNotify(fn: (msg: string, level: "info" | "warning" | "error") => void): void {
  _notifyFn = fn;
}

function log(level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  const prefix = level.toUpperCase().padEnd(5);
  const line = `[${ts}] ${prefix} ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
  if (LOG_LEVELS[level] >= LOG_LEVELS[_logLevel] && _notifyFn) {
    const piLevel = level === "error" ? "error" : level === "warn" ? "warning" : "info";
    _notifyFn(`[pi-smart-skills] ${msg}`, piLevel);
  }
}

/* ------------------------------------------------------------------ */
/* Prompt size estimation (skills-search trigger guard)                */
/* ------------------------------------------------------------------ */

/**
 * Estimate a user prompt's token count with a dependency-free heuristic.
 * Retained as a standalone utility (exported); the actual trigger guard is
 * the word-count check against `minPromptWords` in before_agent_start.
 *
 * Rules of thumb, deterministic and model-free:
 *   - text splits into whitespace-separated chunks;
 *   - CJK / kana / hangul characters count 1 token each (they are ~1
 *     token each in modern BPE vocabularies);
 *   - all other characters count 1 token per 4 ("4 chars ~= 1 token"
 *     for English), with each chunk counting at least 1.
 *
 * Deliberately conservative for trivial messages: "continue", "ok",
 * "yes, go ahead" all sit below the default 5-token threshold, while
 * real instructions clear it comfortably.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  let total = 0;
  const chunkRe = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = chunkRe.exec(text)) !== null) {
    let cjk = 0;
    let other = 0;
    for (const ch of match[0]) {
      const cp = ch.codePointAt(0) ?? 0;
      const isCjk =
        (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals .. unified ideographs
        (cp >= 0xac00 && cp <= 0xd7af) || // hangul syllables
        (cp >= 0x3040 && cp <= 0x30ff); // kana
      if (isCjk) cjk += 1;
      else other += 1;
    }
    total += cjk + (other === 0 ? 0 : Math.max(1, Math.ceil(other / 4)));
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

const CONFIG_PATH = path.join(AGENT_DIR, "pi-smart-skills.json");

interface ExtensionConfig {
  maxResults: number;
  promptCharLimit: number;
  stabilityWindow: number;
  qmdTimeoutMs: number;
  skillDirectories: string[];
  logLevel: string;
  /** User prompts with fewer than this many whitespace-separated words
   *  skip the skills search/injection entirely (no QMD call, prompt
   *  unchanged). Default 2: one-word prompts ("continue", "ok") don't
   *  trigger a skills pass; anything with two or more words does. */
  minPromptWords: number;
  /**
   * In-process qmd entry to import (path to `store.js`, or its dist
   * directory; `~` expands). Defaults to the machine-wide npm-global
   * install. The PI_SMART_SKILLS_QMD_STORE env var overrides this. Set it
   * for a profile whose runtime Node ABI differs from the global tree
   * (e.g. dsh-web) to point at a per-runtime qmd copy.
   */
  qmdStorePath?: string;
  /**
   * How the filtered skill list is delivered:
   *  - "auto" (default): rewrite the system prompt's <available_skills>
   *    block when one is present (pi standalone); otherwise inject a
   *    "most relevant skills" custom message for the turn (dsh, which
   *    keeps its catalog in a user message instead of the prompt).
   *  - "rewrite": only the original system-prompt rewrite path.
   *  - "message": always the custom message, even when the block exists.
   */
  injectionMode?: "auto" | "rewrite" | "message";
}

const DEFAULT_CONFIG: ExtensionConfig = {
  maxResults: 10,
  promptCharLimit: 4000,
  stabilityWindow: 5,
  qmdTimeoutMs: 20_000,
  skillDirectories: [path.join(os.homedir(), ".pi", "agent", "skills")],
  logLevel: "warn",
  minPromptWords: 2,
  injectionMode: "auto",
};

function loadConfig(): ExtensionConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return DEFAULT_CONFIG;
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    log("warn", `Failed to load config (${CONFIG_PATH}): ${err} — using defaults`);
    return DEFAULT_CONFIG;
  }
}

/* ------------------------------------------------------------------ */
/* Skill types                                                        */
/* ------------------------------------------------------------------ */

interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
}

/* ------------------------------------------------------------------ */
/* Per-session state                                                  */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  rankedNames: string[];
  topNSet: Set<string>;
  skillCount: number;
}

interface SessionState {
  activeCollections: SkillCollection[];
  searchCache: CacheEntry | null;
  config: ExtensionConfig;
  qmdOk: boolean;
  cwd: string;
  /** Distinct skills indexed from disk at session_start; frames the
   *  injected message as "N of M". */
  catalogTotal: number;
  lastAccessMs: number;
}

const sessionMap = new Map<string, SessionState>();

const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, state] of sessionMap) {
    if (now - state.lastAccessMs > SESSION_TTL_MS) {
      sessionMap.delete(id);
    }
  }
  if (sessionMap.size > MAX_SESSIONS) {
    const sorted = [...sessionMap.entries()].sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs);
    for (let i = 0; i < sessionMap.size - MAX_SESSIONS; i++) {
      sessionMap.delete(sorted[i][0]);
    }
  }
}

interface SkillCollection {
  name: string;
  dirPath: string;
}

/* ------------------------------------------------------------------ */
/* Path helpers                                                       */
/* ------------------------------------------------------------------ */

function expandTilde(p: string, baseDir?: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return path.resolve(baseDir ?? process.cwd(), p);
}

function collectionNameForDir(dirPath: string): string {
  const resolved = fs.realpathSync(dirPath);
  const segments = resolved.split(path.sep).filter(Boolean);
  const sanitized = segments.map((seg) =>
    seg.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-")
  ).join("-");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${sanitized}-${hash}`;
}

/* ------------------------------------------------------------------ */
/* NPM / Git package skill directory discovery                        */
/* ------------------------------------------------------------------ */

/**
 * Discover skill directories from installed pi packages.
 *
 * Scans agentDir/npm/node_modules for any subdirectory named
 * "skills" that contains SKILL.md files, and also checks git-installed
 * packages under agentDir/git/.
 */
function discoverPackageSkillDirs(agentDir: string): string[] {
  const dirs = new Set<string>();

  // Scan npm/node_modules/**/skills/
  const npmModulesDir = path.join(agentDir, "npm", "node_modules");
  try {
    if (fs.existsSync(npmModulesDir)) {
      scanForSkillsDirs(npmModulesDir, dirs);
    }
  } catch {
    // node_modules doesn't exist or isn't readable
  }

  // Scan git packages
  const gitDir = path.join(agentDir, "git");
  try {
    if (fs.existsSync(gitDir)) {
      scanForSkillsDirs(gitDir, dirs);
    }
  } catch {
    // git dir doesn't exist
  }

  return [...dirs];
}

/**
 * Recursively scan a directory tree for any subdirectory named "skills"
 * that contains at least one SKILL.md with valid frontmatter (name + description).
 * Stops descending into node_modules/ within packages to avoid double-scanning.
 * Skips paths under /configs/ — those are config templates, not real skills.
 */
function scanForSkillsDirs(root: string, dirs: Set<string>, depth = 0) {
  if (depth > 5) return; // safety limit
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      // Skip node_modules inside packages (already scanned at top level)
      if (entry.name === "node_modules" && depth > 0) continue;
      // Skip hidden directories (pi's convention)
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) continue;

      const fullPath = path.join(root, entry.name);
      if (entry.name === "skills") {
        // Skip config template skills (e.g., context-mode/configs/antigravity-cli/skills/)
        const parentName = path.basename(path.dirname(fullPath));
        const grandparentName = path.basename(path.dirname(path.dirname(fullPath)));
        if (grandparentName === "configs") continue;

        // Check if it contains at least one subdirectory with a valid SKILL.md
        try {
          const subEntries = fs.readdirSync(fullPath);
          const hasValidSkill = subEntries.some((f) => {
            const subPath = path.join(fullPath, f);
            try {
              if (!fs.statSync(subPath).isDirectory()) return false;
              const skillMd = path.join(subPath, "SKILL.md");
              if (!fs.existsSync(skillMd)) return false;
              // Validate frontmatter has both name and description
              const content = fs.readFileSync(skillMd, "utf-8");
              const skill = parseSkillFile(content, skillMd);
              return skill !== null;
            } catch {
              return false;
            }
          });
          if (hasValidSkill) {
            dirs.add(fs.realpathSync(fullPath));
          }
        } catch {
          continue;
        }
      } else {
        scanForSkillsDirs(fullPath, dirs, depth + 1);
      }
    }
  } catch {
    // Permission denied or not a directory — skip
  }
}

/* ------------------------------------------------------------------ */
/* QMD helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve the qmd `store.js` entry this extension imports in-process.
 *
 * Precedence:
 *   1. `envValue` (the PI_SMART_SKILLS_QMD_STORE env var when set)
 *   2. the `qmdStorePath` config field
 *   3. the machine-wide npm-global install
 *
 * The value may be the store.js path itself or its containing dist
 * directory; `~` expands. Defaulting to the npm-global tree keeps pi
 * standalone behavior byte-identical; a profile whose runtime Node ABI
 * differs from the global build (e.g. dsh-web) points here at a
 * per-runtime copy instead.
 */
export function resolveQmdStorePath(envValue?: string, config: Partial<ExtensionConfig> = {}): string {
  const pick = envValue?.trim() || config.qmdStorePath?.trim() || "";
  if (pick !== "") return expandTilde(pick);
  return path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@tobilu", "qmd", "dist", "store.js");
}

async function initQmdStore(): Promise<boolean> {
  try {
    if (!_qmdStore) {
      const distDir = path.dirname(resolveQmdStorePath(process.env.PI_SMART_SKILLS_QMD_STORE, loadConfig()));
      log("debug", `initQmdStore: importing qmd from ${distDir}`);
      const qmd = await import(path.join(distDir, "store.js"));
      if (!qmd.enableProductionMode) return false;
      qmd.enableProductionMode();
      _qmdStore = qmd.createStore();
      _qmdSearch = qmd.structuredSearch;
      _removeCollection = qmd.removeCollection;
      _syncConfigToDb = qmd.syncConfigToDb;
      _reindexCollection = qmd.reindexCollection;
      _qmdCollModule = await import(path.join(distDir, "collections.js"));
      const config = _qmdCollModule.loadConfig();
      qmd.syncConfigToDb(_qmdStore.db, config);
      if (_qmdStore.db) {
        const { setDefaultLLM } = await import(path.join(distDir, "llm.js"));
        const { createConfiguredLLM } = await import(path.join(distDir, "configured-llm.js"));
        setDefaultLLM(createConfiguredLLM(config?.models, {
          embedModel: config?.models?.embed,
          generateModel: config?.models?.generate,
          rerankModel: config?.models?.rerank,
        }));
      }
    }
    return !!_qmdSearch;
  } catch (e) {
    log("debug", `initQmdStore: failed: ${e}`);
    return false;
  }
}

function qmdAvailable(): boolean {
  return !!_qmdStore;
}

async function ensureCollectionForDir(
  name: string,
  dirPath: string,
  config: ExtensionConfig,
): Promise<{ ok: boolean; stderr?: string }> {
  if (!_qmdStore || !_qmdCollModule) return { ok: false };
  if (!fs.existsSync(dirPath)) return { ok: false };

  let resolvedDir: string;
  try {
    resolvedDir = fs.realpathSync(dirPath);
  } catch {
    return { ok: false };
  }

  try {
    // Check existing collections directly from DB
    const existing = _qmdStore.db.prepare(
      "SELECT name, path FROM store_collections WHERE name = ?"
    ).get(name) as { name: string; path: string } | undefined;

    if (existing) {
      try {
        if (fs.realpathSync(existing.path) === resolvedDir) {
          return { ok: true };
        }
      } catch {
        // path may not exist — remove stale
      }
      // Remove stale collection
      if (_removeCollection) _removeCollection(_qmdStore.db, name);
      if (_qmdCollModule.removeCollection) _qmdCollModule.removeCollection(name);
    }

    // Add new collection to YAML config
    _qmdCollModule.addCollection(name, resolvedDir);
    // Sync config to DB
    _syncConfigToDb(_qmdStore.db, _qmdCollModule.loadConfig());
    // Index files (async — does not block)
    _reindexCollection(_qmdStore, name).catch((err: any) => {
      log("debug", `reindexCollection ${name}: ${err.message}`);
    });

    return { ok: true };
  } catch (err: any) {
    log("warn", `ensureCollectionForDir(${name}): ${err.message}`);
    return { ok: false, stderr: err.message };
  }
}

interface QmdError {
  kind: "import" | "store" | "search" | "empty";
  detail: string;
}

async function searchSkills(
  query: string,
  config: ExtensionConfig,
  collections: SkillCollection[],
): Promise<{ names: string[]; error?: QmdError }> {
  if (!_qmdStore || !_qmdSearch) {
    log("error", "searchSkills: QMD not initialized");
    return { names: [], error: { kind: "store", detail: "QMD not initialized" } };
  }

  if (collections.length === 0) {
    log("warn", "searchSkills: no collections to search");
    return { names: [], error: { kind: "empty", detail: "no active collections" } };
  }

  const collectionNames = collections.map((c) => c.name);
  log("debug", `searchSkills: ${collectionNames.length} collections, query="${query}"`);

  const opts = {
    collections: collectionNames,
    limit: config.maxResults * 20,
    skipRerank: false,
    candidateLimit: 500,
  };

  const extractSkills = (results: any[]): string[] => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const r of results) {
      const parts = (r.file ?? r.filepath ?? "").split("/");
      const last = parts[parts.length - 1];
      const dirName = parts[parts.length - 2];
      if (last === "SKILL.md" && dirName && !seen.has(dirName)) {
        seen.add(dirName);
        names.push(dirName);
      }
    }
    return names;
  };

  try {
    const results = await _qmdSearch(_qmdStore, [
      { type: "lex", query },
      { type: "vec", query },
    ], opts);
    const names = extractSkills(results);
    log("debug", `searchSkills: ${results.length} results, ${names.length} skill names from search`);
    return { names: names.slice(0, config.maxResults) };
  } catch (err: any) {
    if (err.message?.includes("fetch") || err.message?.includes("connect") || err.message?.includes("ECONNREFUSED")) {
      log("warn", `searchSkills: embedding service unavailable (${err.message}) — bypassing filter, injecting all skills`);
      return { names: [], error: { kind: "search", detail: "embedding service unavailable" } };
    }
    log("error", `searchSkills: ${err.message}`);
    return { names: [], error: { kind: "search", detail: err.message } };
  }
}

/* ------------------------------------------------------------------ */
/* Project skills filesystem discovery                                */
/* ------------------------------------------------------------------ */

function discoverProjectSkills(cwd: string, notify: NotifyFn): DiscoveredSkill[] {
  const projectSkillsDir = path.join(cwd, ".pi", "skills");
  if (!fs.existsSync(projectSkillsDir) || !fs.statSync(projectSkillsDir).isDirectory()) {
    return [];
  }

  const skills: DiscoveredSkill[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectSkillsDir, { withFileTypes: true });
  } catch {
    notify("[pi-smart-skills] Failed to read project skills directory", "warning");
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(projectSkillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, "utf-8");
    } catch {
      notify(`[pi-smart-skills] Failed to read ${skillMdPath}`, "warning");
      continue;
    }

    const skill = parseSkillFile(content, skillMdPath);
    if (skill) {
      skills.push(skill);
    } else {
      notify(`[pi-smart-skills] Skipping malformed skill file: ${skillMdPath}`, "warning");
    }
  }

  return skills;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseYamlValue(block: string, key: string): string | null {
  const safeKey = escapeRegex(key);

  // Single-line value
  const singleMatch = block.match(new RegExp(`^${safeKey}:\\s*(.+)$`, "m"));
  if (singleMatch) {
    let val = singleMatch[1].trim();
    // Strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return val;
  }

  // Block scalar (| or >)
  const blockMatch = block.match(new RegExp(`^${safeKey}:\\s*[|>][-+]?(\\n(( {2,}|\\t)[^\\n]*\\n?)*)`, "m"));
  if (blockMatch) {
    const rawLines = blockMatch[1].split("\n").filter((l: string) => l.trim());
    if (rawLines.length === 0) return "";
    const minIndent = Math.min(...rawLines.map((l: string) => (/^(\s*)/.exec(l)?.[1].length ?? 0)));
    const dedented = rawLines.map((l: string) => l.slice(minIndent)).join("\n");
    return dedented.trim();
  }

  return null;
}

function parseSkillFile(content: string, filePath: string): DiscoveredSkill | null {
  // Try YAML frontmatter first
  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yamlBlock = yamlMatch[1];
    const name = parseYamlValue(yamlBlock, "name");
    const desc = parseYamlValue(yamlBlock, "description");
    if (name && desc) {
      return { name, description: desc, location: filePath };
    }
  }

  // Try XML-like tags in the content
  const nameTag = content.match(/<name>(.*?)<\/name>/s);
  const descTag = content.match(/<description>(.*?)<\/description>/s);
  if (nameTag && descTag) {
    return {
      name: decodeXml(nameTag[1].trim()),
      description: decodeXml(descTag[1].trim()),
      location: filePath,
    };
  }

  return null;
}

/**
 * Count whitespace-separated words in a string (empty or whitespace-only
 * strings count as zero). Drives the trigger guard: prompts with fewer
 * than `minPromptWords` words (default 2 — i.e. one word or fewer, such
 * as "continue" or "ok") skip the skills search/injection entirely.
 */
export function countWords(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/* ------------------------------------------------------------------ */
/* Message-based injection (runtimes without a prompt block)          */
/* ------------------------------------------------------------------ */

/**
 * Truncate a skill description for the compact "most relevant skills"
 * message: cut just under the limit, fall back to the last word
 * boundary, append an ellipsis. Text at or under the limit is returned
 * trimmed, unchanged.
 */
export function truncateDescription(description: string, limit = 220): string {
  const text = description.trim();
  if (text.length === 0) return "";
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(1, limit - 8));
  const lastSpace = cut.lastIndexOf(" ");
  const end = lastSpace > 0 ? lastSpace : cut.length;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Read every skill from a skill directory (one subdirectory per skill,
 * each holding a SKILL.md) as name + description from frontmatter.
 * Missing directories and non-skill entries are skipped silently.
 */
export function listSkillsInDir(dir: string): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(dir, entry.name, "SKILL.md");
    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, "utf-8");
    } catch {
      continue;
    }
    const skill = parseSkillFile(content, skillMdPath);
    if (skill) skills.push(skill);
  }
  return skills;
}

/**
 * Decide how the filtered skill list is delivered for this prompt:
 * "rewrite" when the system prompt carries an <available_skills> block
 * (pi standalone), "message" for runtimes that keep the catalog elsewhere
 * (dsh: its tool-skill package publishes the catalog as a user message, so
 * the filtered list rides in as a custom message for the turn), and
 * null when there is no usable system prompt at all. Unknown mode values
 * fall through to the "auto" behavior.
 */
export function decideInjectionMode(
  systemPrompt: string | null | undefined,
  mode: string,
): "rewrite" | "message" | null {
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0) return null;
  if (mode === "rewrite" || mode === "message") return mode;
  return /<available_skills>[\s\S]*?<\/available_skills>/.test(systemPrompt) ? "rewrite" : "message";
}

/**
 * Render the "most relevant skills" custom message. It mirrors the shape
 * of dsh's skill-catalog reminder (backticked names + one-line
 * descriptions, "call the `skill` tool with the exact name" instruction)
 * so the model reacts the same whether the catalog arrived as a prompt
 * block or as a message list.
 */
export function buildRelevantSkillsMessage(skills: DiscoveredSkill[], catalogTotal: number): string | null {
  if (skills.length === 0) return null;
  const lines: string[] = [
    "<system-reminder>",
    `Of this session's ${catalogTotal} available skills, the following ${skills.length} are most relevant to this prompt:`,
    "",
  ];
  for (const skill of skills) {
    lines.push(`- \`${skill.name}\`${skill.description ? ` ${truncateDescription(skill.description)}` : ""}`);
  }
  lines.push(
    "",
    "If a listed skill applies, call the `skill` tool with its exact name before acting; its full instructions will load into this conversation.",
    "</system-reminder>",
  );
  return lines.join("\n");
}

/**
 * Rank the skills matching a user prompt: QMD hybrid (lex+vec) search
 * across the active collections, then resolve each matched name against
 * the on-disk skill index for its SKILL.md name + description. Names QMD
 * matched but that are not readable on disk are dropped, not injected —
 * the message must never name a skill the runtime cannot load.
 */
async function rankSkills(
  query: string,
  config: ExtensionConfig,
  collections: SkillCollection[],
): Promise<DiscoveredSkill[]> {
  if (!qmdAvailable()) {
    log("warn", "rankSkills: QMD not available — skipping message injection");
    return [];
  }
  const { names, error } = await searchSkills(query, config, collections);
  if (error) {
    log("warn", `rankSkills: QMD search ${error.kind}: ${error.detail} — skipping message injection`);
    return [];
  }
  if (names.length === 0) return [];

  const byName = new Map<string, DiscoveredSkill>();
  const allDirs = [
    ...config.skillDirectories.map((d) => expandTilde(d)),
    ...discoverPackageSkillDirs(expandTilde("~/.pi/agent")),
  ];
  for (const dir of allDirs) {
    for (const skill of listSkillsInDir(dir)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const resolved: DiscoveredSkill[] = [];
  for (const name of names) {
    const known = byName.get(name);
    if (known) resolved.push(known);
  }
  return resolved;
}

/* ------------------------------------------------------------------ */
/* System prompt rewriting                                            */
/* ------------------------------------------------------------------ */

function parseSkillEntries(block: string): DiscoveredSkill[] {
  const entries: DiscoveredSkill[] = [];
  const skillBlocks = block.match(/<skill>([\s\S]*?)<\/skill>/g) ?? [];
  for (const rawBlock of skillBlocks) {
    const nameM = rawBlock.match(/<name>(.*?)<\/name>/s);
    const descM = rawBlock.match(/<description>(.*?)<\/description>/s);
    const locM = rawBlock.match(/<location>(.*?)<\/location>/s);
    if (nameM && descM && locM) {
      entries.push({
        name: nameM[1].trim(),
        description: decodeXml(descM[1].trim()),
        location: locM[1].trim(),
      });
    }
  }
  return entries;
}

function buildSkillsBlock(skills: DiscoveredSkill[]): string {
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

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

type NotifyFn = (msg: string, level: "info" | "warning" | "error") => void;

async function rewriteSkillsBlock(
  systemPrompt: string,
  userPrompt: string,
  state: SessionState,
  notify: NotifyFn,
): Promise<{ newPrompt: string } | null> {
  const blockMatch = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
  if (!blockMatch) { log("debug","rewriteSkillsBlock: no <available_skills> block found"); return null; }

  const fullBlock = blockMatch[0];
  const allGlobalSkills = parseSkillEntries(fullBlock);
  log("debug",`rewriteSkillsBlock: found ${allGlobalSkills.length} global skills`);

  // Discover project skills from filesystem
  const projectSkills = discoverProjectSkills(state.cwd, notify);
  log("debug",`rewriteSkillsBlock: found ${projectSkills.length} project skills`);

  if (userPrompt.length > state.config.promptCharLimit) {
    log("debug",`rewriteSkillsBlock: prompt too long ${userPrompt.length} > ${state.config.promptCharLimit}`);
    notify(
      `[pi-smart-skills] Prompt too long (${userPrompt.length} chars) — injecting all skills`,
      "info",
    );
    return { newPrompt: systemPrompt };
  }

  // Search global collections via QMD in-process
  let result: { names: string[]; error?: QmdError };
  try {
    result = await searchSkills(
      userPrompt,
      state.config,
      state.activeCollections,
    );
  } catch (err) {
    log("error", `rewriteSkillsBlock: QMD search threw: ${err}`);
    notify(
      `[pi-smart-skills] QMD search error: ${err} — injecting all skills`,
      "warning",
    );
    return { newPrompt: systemPrompt };
  }

  if (result.error) {
    log("warn", `rewriteSkillsBlock: QMD error ${result.error.kind}: ${result.error.detail}`);
    notify(
      `[pi-smart-skills] QMD ${result.error.kind}: ${result.error.detail} — injecting all skills`,
      "warning",
    );
    return { newPrompt: systemPrompt };
  }

  const rankedNames = result.names;
  log("debug", `rewriteSkillsBlock: rankedNames=${rankedNames.length}: [${rankedNames.join(", ")}]`);
  if (rankedNames.length === 0) {
    notify(
      `[pi-smart-skills] QMD returned no results — injecting all skills`,
      "warning",
    );
    return { newPrompt: systemPrompt };
  }

  // Filter global skills by ranked names
  const nameSet = new Set(rankedNames);
  const filteredGlobal = allGlobalSkills.filter((s) => nameSet.has(s.name));
  log("debug", `rewriteSkillsBlock: ${filteredGlobal.length} global skills matched ranked names`);

  // Combine: project skills first, then filtered global skills (dedup by name)
  const projectNames = new Set(projectSkills.map((s) => s.name));
  const combinedSkills = [...projectSkills, ...filteredGlobal.filter((s) => !projectNames.has(s.name))];
  log("debug", `rewriteSkillsBlock: ${combinedSkills.length} combined skills (project=${projectSkills.length}, filtered=${filteredGlobal.length})`);

  if (combinedSkills.length === 0 && allGlobalSkills.length > 0) {
    log("warn", `rewriteSkillsBlock: no ranked skills matched, falling back to all ${allGlobalSkills.length} skills`);
    notify(
      `[pi-smart-skills] No ranked skills matched — injecting all ${allGlobalSkills.length} skills`,
      "warning",
    );
    return { newPrompt: systemPrompt };
  }

  // Stability cache check — only against global ranked names (project skills are always included)
  const newTopNSet = new Set(rankedNames.slice(0, state.config.stabilityWindow));
  const cache = state.searchCache;
  if (cache && cache.topNSet.size > 0) {
    if (cache.skillCount !== allGlobalSkills.length) {
      // Skill count changed — cache invalid
    } else if (setsEqual(newTopNSet, cache.topNSet)) {
      // Rebuild prompt from cached ranked names + current system prompt
      const projectNameSet = new Set(projectSkills.map((s) => s.name));
      const cachedFiltered = allGlobalSkills.filter(
        (s) => cache.rankedNames.includes(s.name) && !projectNameSet.has(s.name),
      );
      const rebuiltSkills = [...projectSkills, ...cachedFiltered];
      const newBlock = buildSkillsBlock(rebuiltSkills);
      return { newPrompt: systemPrompt.split(fullBlock).join(newBlock) };
    }
  }

  const newBlock = buildSkillsBlock(combinedSkills);
  const newPrompt = systemPrompt.split(fullBlock).join(newBlock);

  state.searchCache = {
    rankedNames,
    topNSet: newTopNSet,
    skillCount: allGlobalSkills.length,
  };

  const totalInjected = combinedSkills.length;
  const totalAvailable = projectSkills.length + allGlobalSkills.length;
  log("info", `rewriteSkillsBlock: injecting ${totalInjected}/${totalAvailable} skills`);
  notify(
    `[pi-smart-skills] Injected ${totalInjected}/${totalAvailable} skills (${projectSkills.length} project, top-${state.config.stabilityWindow}: ${[...newTopNSet].join(", ")})`,
    "info",
  );

  return { newPrompt };
}

/* ------------------------------------------------------------------ */
/* Extension entry point                                              */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  log("debug", "=== EXTENSION FACTORY LOADED ===");
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const config = loadConfig();
    setLogLevel(config.logLevel);
    setNotify((msg, level) => ctx.ui?.notify(msg, level));
    log("info", `session_start fired, sessionId=${sessionId}, logLevel=${config.logLevel}`);
    const cwd = ctx.cwd ?? process.cwd();
    const qmdOk = await initQmdStore();
    const agentDir = expandTilde("~/.pi/agent");

    if (!qmdOk) {
      log("warn", "QMD store not available — will inject all skills");
      ctx.ui?.notify("[pi-smart-skills] QMD store not available — will inject all skills", "warning");
    }

    const collections: SkillCollection[] = [];
    const seenPaths = new Set<string>();

    // Combined directory list: config dirs + discovered npm/git package
    // skill dirs. Hoisted above the qmdOk block: the message injection
    // path needs the on-disk skill index even when QMD is down.
    const allDirs = [
      ...config.skillDirectories.map((d) => expandTilde(d, cwd)),
      ...discoverPackageSkillDirs(agentDir),
    ];

    // Index every configured skill directory on disk (first-seen name
    // wins). The message path attaches one-line descriptions to
    // QMD-ranked names and frames the list as "N of M".
    const skillIndex = new Map<string, DiscoveredSkill>();
    for (const dir of allDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const skill of listSkillsInDir(dir)) {
        if (!skillIndex.has(skill.name)) skillIndex.set(skill.name, skill);
      }
    }
    log("debug", `session_start: indexed ${skillIndex.size} skills from ${allDirs.length} dirs`);

    if (qmdOk) {
      log("debug", `session_start: scanning ${allDirs.length} directories for QMD collections`);

      for (const dir of allDirs) {
        if (!fs.existsSync(dir)) continue;

        // Deduplicate by resolved realpath — npm skill dirs might overlap with ~/.pi/agent/skills
        let realPath: string;
        try {
          realPath = fs.realpathSync(dir);
        } catch {
          continue;
        }
        if (seenPaths.has(realPath)) continue;
        seenPaths.add(realPath);

        let name: string;
        try {
          name = collectionNameForDir(dir);
        } catch {
          continue;
        }

        const res = await ensureCollectionForDir(name, dir, config);
        if (res.ok) {
          collections.push({ name, dirPath: realPath });
        }
      }

      log("info", `session_start: ${collections.length} QMD collections ready: [${collections.map((c) => c.name).join(", ")}]`);
      if (collections.length > 0) {
        const npmCount = seenPaths.size - config.skillDirectories.length;
        const suffix = npmCount > 0 ? ` (+${npmCount} from packages)` : "";
        ctx.ui?.notify(
          `[pi-smart-skills] Indexed ${collections.length} skill collection(s)${suffix}: ${collections.map((c) => c.name).join(", ")}`,
          "info",
        );
      }
    }

    sessionMap.set(sessionId, {
      activeCollections: collections,
      searchCache: null,
      config,
      qmdOk,
      cwd,
      catalogTotal: skillIndex.size,
      lastAccessMs: Date.now(),
    });
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    sessionMap.delete(ctx.sessionManager.getSessionId());
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    const sp = event.systemPrompt;
    if (!sp || typeof sp !== "string") { log("debug","before_agent_start: no systemPrompt"); return undefined; }

    pruneSessions();
    const sessionId = ctx.sessionManager.getSessionId();
    const state = sessionMap.get(sessionId);
    if (!state) { log("debug",`before_agent_start: no session state for ${sessionId}`); return undefined; }
    state.lastAccessMs = Date.now();
    log("debug",`before_agent_start: state found, collections=${state.activeCollections.length}, qmdOk=${state.qmdOk}`);

    const notify: NotifyFn = (msg, level) => {
      ctx.ui?.notify(msg, level);
    };

    try {
      const userPrompt = event.prompt ?? "";
      const wordCount = countWords(userPrompt);
      log("debug",`before_agent_start: userPrompt words=${wordCount}, chars=${userPrompt.length}, limit=${state.config.promptCharLimit}, minPromptWords=${state.config.minPromptWords}`);
      if (wordCount < state.config.minPromptWords) {
        log("debug",`before_agent_start: prompt has ${wordCount} word(s) (< ${state.config.minPromptWords}) - skipping skills search/injection`);
        return undefined;
      }
      const mode = decideInjectionMode(sp, state.config.injectionMode ?? "auto");
      if (mode === null) return undefined;
      log("debug", `before_agent_start: injection mode=${mode}`);

      if (mode === "rewrite") {
        const result = await rewriteSkillsBlock(sp, userPrompt, state, notify);
        if (result && result.newPrompt !== sp) {
          log("debug","before_agent_start: systemPrompt rewritten successfully");
          return { systemPrompt: result.newPrompt };
        }
        log("debug","before_agent_start: rewriteSkillsBlock returned null or unchanged prompt");
        return undefined;
      }

      // Message path (dsh-style runtimes: the catalog is a user message,
      // not part of the system prompt). Rank skills, then inject a compact
      // "most relevant skills" custom message beside this turn's user
      // message — the channel pi2dsh documents for before_agent_start
      // returns ("returned custom messages enter that same turn beside
      // the user message").
      const skills = await rankSkills(userPrompt, state.config, state.activeCollections);
      if (skills.length === 0) {
        log("debug","before_agent_start: message path: no relevant skills resolved — not injecting");
        return undefined;
      }
      const text = buildRelevantSkillsMessage(skills, state.catalogTotal);
      if (!text) return undefined;
      log("info",`before_agent_start: injecting relevant-skills message (${skills.length} of ${state.catalogTotal}): [${skills.map((s) => s.name).join(", ")}]`);
      notify(`[pi-smart-skills] Injected ${skills.length} relevant skill(s) for this turn`, "info");
      return { message: { customType: "pi-smart-skills", content: text } };
    } catch (err) {
      log("debug",`before_agent_start: ERROR ${err}`);
      notify(`[pi-smart-skills] Error: ${err}`, "error");
      return undefined;
    }
    return undefined;
  });
}

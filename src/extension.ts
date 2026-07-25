import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
}

const DEFAULT_CONFIG: ExtensionConfig = {
  maxResults: 10,
  promptCharLimit: 4000,
  stabilityWindow: 5,
  qmdTimeoutMs: 20_000,
  skillDirectories: [path.join(os.homedir(), ".pi", "agent", "skills")],
  logLevel: "warn",
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
  lastAccessMs: number;
  collectionCache: Map<string, string> | null;
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

function qmdAvailable(): boolean {
  const result = spawnSync("qmd", ["--version"], {
    encoding: "utf-8",
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

function ensureCollectionForDir(
  name: string,
  dirPath: string,
  config: ExtensionConfig,
  collectionCache: Map<string, string> | null,
): { ok: boolean; stderr?: string } {
  if (!fs.existsSync(dirPath)) {
    return { ok: false };
  }

  let resolvedDir: string;
  try {
    resolvedDir = fs.realpathSync(dirPath);
  } catch {
    return { ok: false };
  }

  const listResult = spawnSync("qmd", ["collection", "list"], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs,
  });

  if (!listResult.error && listResult.status === 0) {
    const collectionNames = parseCollectionList(listResult.stdout);

    const nameToPath = new Map<string, string>();
    for (const collName of collectionNames) {
      if (collectionCache?.has(collName)) {
        nameToPath.set(collName, collectionCache.get(collName)!);
      } else {
        const showResult = spawnSync("qmd", ["collection", "show", collName], {
          encoding: "utf-8",
          timeout: config.qmdTimeoutMs,
        });
        if (!showResult.error && showResult.status === 0) {
          const pathMatch = showResult.stdout.match(/Path:\s+(.+)/);
          if (pathMatch) {
            nameToPath.set(collName, pathMatch[1].trim());
          }
        }
      }
    }

    if (collectionCache) {
      for (const [n, p] of nameToPath) {
        collectionCache.set(n, p);
      }
    }

    for (const [collName, rawPath] of nameToPath) {
      if (collName === name) {
        const existingPath = fs.realpathSync(rawPath);
        if (existingPath === resolvedDir) {
          // Collection exists with correct name and path — just update it
          const updateResult = spawnSync("qmd", ["update", name], {
            encoding: "utf-8",
            timeout: config.qmdTimeoutMs * 2,
          });
          if (updateResult.error || updateResult.status !== 0) {
            const stderr = updateResult.stderr?.trim() ?? "";
            console.warn(`[pi-smart-skills] Failed to update collection "${name}": ${stderr}`);
            return { ok: false, stderr };
          }
          return { ok: true };
        } else {
          // Same name, different path — remove stale and re-add below
          const removeResult = spawnSync("qmd", ["collection", "remove", collName], {
            encoding: "utf-8",
            timeout: config.qmdTimeoutMs,
          });
          if (removeResult.error || removeResult.status !== 0) {
            console.warn(`[pi-smart-skills] Failed to remove stale collection "${collName}"`);
            return { ok: false };
          }
          break;
        }
      }
      try {
        const existingPath = fs.realpathSync(rawPath);
        if (existingPath === resolvedDir) {
          const removeResult = spawnSync("qmd", ["collection", "remove", collName], {
            encoding: "utf-8",
            timeout: config.qmdTimeoutMs,
          });
          if (removeResult.error || removeResult.status !== 0) {
            console.warn(`[pi-smart-skills] Failed to remove stale collection "${collName}"`);
            return { ok: false };
          }
          break;
        }
      } catch {
        // realpath failed — skip this collection
      }
    }
  }

  const addResult = spawnSync("qmd", ["collection", "add", resolvedDir, "--name", name], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs,
  });

  if (addResult.error || addResult.status !== 0) {
    const stderr = addResult.stderr?.trim() ?? "";
    console.warn(`[pi-smart-skills] Failed to add collection "${name}": ${stderr}`);
    return { ok: false, stderr };
  }

  const updateResult = spawnSync("qmd", ["update", name], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs * 2,
  });

  if (updateResult.error || updateResult.status !== 0) {
    const stderr = updateResult.stderr?.trim() ?? "";
    console.warn(`[pi-smart-skills] Failed to update collection "${name}": ${stderr}`);
    return { ok: false, stderr };
  }

  return { ok: true };
}

interface QmdError {
  kind: "spawn" | "timeout" | "exit" | "parse" | "empty";
  detail: string;
}

function parseCollectionList(stdout: string): string[] {
  // Try JSON format first
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      const names = parsed.map((item: any) => item.name ?? item.id ?? String(item)).filter(Boolean);
      if (names.length > 0) return names;
    }
  } catch {
    // Not JSON — fall through to regex
  }

  // Fallback: regex parsing
  const matches = stdout.match(/^\s*[a-zA-Z0-9_-]+\s+\(qmd:\/\//gm) ?? [];
  const names = matches.map((line) => line.trim().split(/\s/)[0]);

  if (names.length === 0) {
    console.warn("[pi-smart-skills] QMD collection list regex matched zero lines — output may have changed format");
  }

  return names;
}

function searchQMD(
  collectionName: string,
  query: string,
  config: ExtensionConfig,
): { names: string[]; error?: QmdError } {
  log("debug", `searchQMD: collection=${collectionName}, query="${query}", maxResults=${config.maxResults}, timeout=${config.qmdTimeoutMs}ms`);
  const lockFile = path.join(os.tmpdir(), "pi-smart-skills-qmd.lock");
  const qmdArgs = ["query", collectionName, query, "-n", String(config.maxResults), "--format", "json"];
  const result = spawnSync(
    "flock",
    ["-w", String(Math.floor(config.qmdTimeoutMs / 1000) + 5), lockFile, "qmd", ...qmdArgs],
    {
      encoding: "utf-8",
      timeout: config.qmdTimeoutMs + 10_000, // extra headroom for lock wait
    },
  );

  if (result.error) {
    log("error", `searchQMD: spawn error: ${result.error.message}`);
    return { names: [], error: { kind: "spawn", detail: result.error.message } };
  }
  if (result.signal === "SIGTERM") {
    log("warn", `searchQMD: timed out after ${config.qmdTimeoutMs}ms`);
    return { names: [], error: { kind: "timeout", detail: `qmd query timed out after ${config.qmdTimeoutMs}ms` } };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    log("error", `searchQMD: exit ${result.status}: ${stderr}`);
    return { names: [], error: { kind: "exit", detail: `exit ${result.status}${stderr ? ": " + stderr : ""}` } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    log("error", `searchQMD: JSON parse error: ${String(e)}, stdout starts: ${result.stdout?.substring(0, 200)}`);
    return { names: [], error: { kind: "parse", detail: String(e) } };
  }

  if (!Array.isArray(parsed)) {
    log("error", `searchQMD: unexpected response format`);
    return { names: [], error: { kind: "parse", detail: "unexpected response format" } };
  }

  log("debug", `searchQMD: got ${parsed.length} results from QMD`);

  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of parsed) {
    if (!item.file) continue;
    // Only extract skill names from SKILL.md files — take the parent directory name
    const parts = item.file.split(path.sep);
    const fileName = parts[parts.length - 1];
    if (fileName !== "SKILL.md") continue;
    const skillName = parts[parts.length - 2];
    if (skillName && !seen.has(skillName)) {
      seen.add(skillName);
      names.push(skillName);
    }
    if (names.length >= config.maxResults) break;
  }

  log("debug", `searchQMD: returning ${names.length} skill names: [${names.join(", ")}]`);
  return { names };
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

/* ------------------------------------------------------------------ */
/* Search across collections                                          */
/* ------------------------------------------------------------------ */

function searchAllCollections(
  collections: SkillCollection[],
  query: string,
  config: ExtensionConfig,
): { names: string[]; error?: QmdError } {
  log("debug", `searchAllCollections: ${collections.length} collections, query="${query}"`);
  if (collections.length === 0) {
    log("warn", "searchAllCollections: no active collections");
    return { names: [], error: { kind: "empty", detail: "no active collections" } };
  }

  const nameRank = new Map<string, number>();
  let firstError: QmdError | undefined;

  for (const coll of collections) {
    try {
      const result = searchQMD(coll.name, query, config);
      if (result.error) {
        log("debug", `searchAllCollections: collection ${coll.name} failed: ${result.error.detail}`);
        if (!firstError) firstError = result.error;
        continue;
      }
      log("debug", `searchAllCollections: collection ${coll.name} returned ${result.names.length} names`);

      for (let i = 0; i < result.names.length; i++) {
        const name = result.names[i];
        const current = nameRank.get(name);
        if (current === undefined || i < current) {
          nameRank.set(name, i);
        }
      }
    } catch (err) {
      log("error", `searchAllCollections: unexpected error in collection ${coll.name}: ${err}`);
      if (!firstError) firstError = { kind: "spawn", detail: "unexpected error during search" };
    }
  }

  const ranked = [...nameRank.entries()].sort((a, b) => a[1] - b[1]);
  const finalNames = ranked.map(([name]) => name);
  log("debug", `searchAllCollections: final ${finalNames.length} ranked names: [${finalNames.join(", ")}]`);
  if (firstError) log("debug", `searchAllCollections: first error was: ${firstError.detail}`);
  return { names: finalNames, error: firstError };
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

function rewriteSkillsBlock(
  systemPrompt: string,
  userPrompt: string,
  state: SessionState,
  notify: NotifyFn,
): { newPrompt: string } | null {
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

  // Search global collections via QMD
  let result: { names: string[]; error?: QmdError };
  try {
    result = searchAllCollections(state.activeCollections, userPrompt, state.config);
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
    const qmdOk = qmdAvailable();
    const agentDir = expandTilde("~/.pi/agent");

    if (!qmdOk) {
      log("warn", "QMD binary not found — will inject all skills");
      ctx.ui?.notify("[pi-smart-skills] QMD binary not found — will inject all skills", "warning");
    }

    const collections: SkillCollection[] = [];
    const collectionCache = new Map<string, string>();
    const seenPaths = new Set<string>();

    if (qmdOk) {
      // Build combined directory list: config dirs + discovered npm/git package skill dirs
      const allDirs = [
        ...config.skillDirectories.map((d) => expandTilde(d, cwd)),
        ...discoverPackageSkillDirs(agentDir),
      ];
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

        const res = ensureCollectionForDir(name, dir, config, collectionCache);
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
      lastAccessMs: Date.now(),
      collectionCache,
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
      log("debug",`before_agent_start: userPrompt length=${userPrompt.length}, limit=${state.config.promptCharLimit}`);
      const result = rewriteSkillsBlock(sp, userPrompt, state, notify);
      if (result && result.newPrompt !== sp) {
        log("debug","before_agent_start: systemPrompt rewritten successfully");
        return { systemPrompt: result.newPrompt };
      } else {
        log("debug","before_agent_start: rewriteSkillsBlock returned null or unchanged prompt");
      }
    } catch (err) {
      log("debug",`before_agent_start: ERROR ${err}`);
      notify(`[pi-smart-skills] Error: ${err}`, "error");
      return { systemPrompt: sp };
    }
    return undefined;
  });
}

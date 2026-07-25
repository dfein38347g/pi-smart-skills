import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
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
  skillDirectories: string[];
}

const DEFAULT_CONFIG: ExtensionConfig = {
  maxResults: 10,
  promptCharLimit: 4000,
  stabilityWindow: 5,
  qmdTimeoutMs: 5_000,
  skillDirectories: [path.join(os.homedir(), ".pi", "agent", "skills")],
};

function loadConfig(): ExtensionConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return DEFAULT_CONFIG;
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    console.warn(`[pi-smart-skills] Failed to load config (${CONFIG_PATH}): ${err} — using defaults`);
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
  const result = spawnSync(
    "qmd",
    ["query", collectionName, query, "-n", String(config.maxResults), "--format", "json"],
    {
      encoding: "utf-8",
      timeout: config.qmdTimeoutMs,
    },
  );

  if (result.error) {
    return { names: [], error: { kind: "spawn", detail: result.error.message } };
  }
  if (result.signal === "SIGTERM") {
    return { names: [], error: { kind: "timeout", detail: `qmd query timed out after ${config.qmdTimeoutMs}ms` } };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    return { names: [], error: { kind: "exit", detail: `exit ${result.status}${stderr ? ": " + stderr : ""}` } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { names: [], error: { kind: "parse", detail: String(e) } };
  }

  if (!Array.isArray(parsed)) {
    return { names: [], error: { kind: "parse", detail: "unexpected response format" } };
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of parsed) {
    if (!item.file) continue;
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
  if (collections.length === 0) {
    return { names: [], error: { kind: "empty", detail: "no active collections" } };
  }

  const nameRank = new Map<string, number>();
  let firstError: QmdError | undefined;

  for (const coll of collections) {
    try {
      const result = searchQMD(coll.name, query, config);
      if (result.error) {
        if (!firstError) firstError = result.error;
        continue;
      }

      for (let i = 0; i < result.names.length; i++) {
        const name = result.names[i];
        const current = nameRank.get(name);
        if (current === undefined || i < current) {
          nameRank.set(name, i);
        }
      }
    } catch {
      if (!firstError) firstError = { kind: "spawn", detail: "unexpected error during search" };
    }
  }

  const ranked = [...nameRank.entries()].sort((a, b) => a[1] - b[1]);
  return { names: ranked.map(([name]) => name), error: firstError };
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
  if (!blockMatch) return null;

  const fullBlock = blockMatch[0];
  const allGlobalSkills = parseSkillEntries(fullBlock);

  // Discover project skills from filesystem
  const projectSkills = discoverProjectSkills(state.cwd, notify);

  if (userPrompt.length > state.config.promptCharLimit) {
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
    notify(
      `[pi-smart-skills] QMD search error: ${err} — injecting all skills`,
      "warning",
    );
    return { newPrompt: systemPrompt };
  }

  if (result.error) {
    notify(
      `[pi-smart-skills] QMD ${result.error.kind}: ${result.error.detail} — injecting all skills`,
      "warning",
    );
    return { newPrompt: systemPrompt };
  }

  const rankedNames = result.names;
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

  // Combine: project skills first, then filtered global skills (dedup by name)
  const projectNames = new Set(projectSkills.map((s) => s.name));
  const combinedSkills = [...projectSkills, ...filteredGlobal.filter((s) => !projectNames.has(s.name))];

  if (combinedSkills.length === 0 && allGlobalSkills.length > 0) {
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
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const config = loadConfig();
    const qmdOk = qmdAvailable();
    const cwd = ctx.cwd ?? process.cwd();

    if (!qmdOk) {
      ctx.ui?.notify("[pi-smart-skills] QMD binary not found — will inject all skills", "warning");
    }

    const collections: SkillCollection[] = [];
    const collectionCache = new Map<string, string>();

    if (qmdOk) {
      for (const dir of config.skillDirectories) {
        const resolved = expandTilde(dir, cwd);
        if (!fs.existsSync(resolved)) continue;

        let name: string;
        try {
          name = collectionNameForDir(resolved);
        } catch {
          continue;
        }

        const res = ensureCollectionForDir(name, resolved, config, collectionCache);
        if (res.ok) {
          collections.push({ name, dirPath: resolved });
        }
      }

      if (collections.length > 0) {
        ctx.ui?.notify(
          `[pi-smart-skills] Indexed ${collections.length} skill collection(s): ${collections.map((c) => c.name).join(", ")}`,
          "info",
        );
      }
    }

    const sessionId = ctx.sessionManager.getSessionId();
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
    if (!sp || typeof sp !== "string") return undefined;

    pruneSessions();
    const state = sessionMap.get(ctx.sessionManager.getSessionId());
    if (!state) return undefined;
    state.lastAccessMs = Date.now();

    const notify: NotifyFn = (msg, level) => {
      ctx.ui?.notify(msg, level);
    };

    try {
      const userPrompt = event.prompt ?? "";
      const result = rewriteSkillsBlock(sp, userPrompt, state, notify);
      if (result && result.newPrompt !== sp) {
        return { systemPrompt: result.newPrompt };
      }
    } catch (err) {
      notify(`[pi-smart-skills] Error: ${err}`, "error");
      return { systemPrompt: sp };
    }
    return undefined;
  });
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  cronIntervalMs: number;
  skillDirectories: string[];
}

const DEFAULT_CONFIG: ExtensionConfig = {
  maxResults: 10,
  promptCharLimit: 4000,
  stabilityWindow: 5,
  qmdTimeoutMs: 5_000,
  cronIntervalMs: 5 * 60 * 1_000,
  skillDirectories: [path.join(os.homedir(), ".pi", "agent", "skills")],
};

function loadConfig(): ExtensionConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
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
}

interface SessionState {
  activeCollections: SkillCollection[];
  searchCache: CacheEntry | null;
  config: ExtensionConfig;
  qmdOk: boolean;
  cronTimer: ReturnType<typeof setInterval> | null;
  cwd: string;
}

const sessionMap = new Map<object, SessionState>();

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
  return `pi-smart-skills-${sanitized.slice(0, 60)}`;
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
): { ok: boolean; stderr?: string } {
  if (!fs.existsSync(dirPath)) {
    return { ok: false };
  }

  const resolvedDir = fs.realpathSync(dirPath);

  const listResult = spawnSync("qmd", ["collection", "list"], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs,
  });

  if (!listResult.error && listResult.status === 0) {
    const existingCollections = listResult.stdout.match(/^[a-zA-Z0-9_-]+\s+\(qmd:\/\//gm) ?? [];
    const collectionNames = existingCollections.map((line) => line.trim().split(/\s/)[0]);

    for (const collName of collectionNames) {
      if (collName === name) {
        return { ok: true };
      }

      const showResult = spawnSync("qmd", ["collection", "show", collName], {
        encoding: "utf-8",
        timeout: config.qmdTimeoutMs,
      });

      if (showResult.error || showResult.status !== 0) {
        continue;
      }

      const pathMatch = showResult.stdout.match(/Path:\s+(.+)/);
      if (pathMatch) {
        try {
          const existingPath = fs.realpathSync(pathMatch[1].trim());
          if (existingPath === resolvedDir) {
            spawnSync("qmd", ["collection", "remove", collName], {
              encoding: "utf-8",
              timeout: config.qmdTimeoutMs,
            });
            break;
          }
        } catch {
          // realpath failed — skip this collection
        }
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

  const updateResult = spawnSync("qmd", ["update"], {
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
  const jsonResult = spawnSync("qmd", ["collection", "list", "--format", "json"], {
    encoding: "utf-8",
    timeout: 5_000,
  });

  if (!jsonResult.error && jsonResult.status === 0) {
    try {
      const parsed = JSON.parse(jsonResult.stdout);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => item.name ?? item.id ?? String(item)).filter(Boolean);
      }
    } catch {
      // Fall through to regex parsing
    }
  }

  // Fallback: regex parsing
  const matches = stdout.match(/^[a-zA-Z0-9_-]+\s+\(qmd:\/\//gm) ?? [];
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
  if (result.status === 124 || result.signal === "SIGTERM") {
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

function parseSkillFile(content: string, filePath: string): DiscoveredSkill | null {
  // Try YAML frontmatter first
  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yamlBlock = yamlMatch[1];
    const nameMatch = yamlBlock.match(/^name:\s*(.+)$/m);
    const descMatch = yamlBlock.match(/^description:\s*(.+)$/m);
    if (nameMatch && descMatch) {
      return {
        name: nameMatch[1].trim(),
        description: descMatch[1].trim(),
        location: filePath,
      };
    }
  }

  // Try instructions/frontmatter block with name/description fields
  const instNameMatch = content.match(/^---\nname:\s*(.+)$/m);
  const instDescMatch = content.match(/^description:\s*(.+)$/m);
  if (instNameMatch && instDescMatch) {
    return {
      name: instNameMatch[1].trim(),
      description: instDescMatch[1].trim(),
      location: filePath,
    };
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
  const regex =
    /<skill>\s*<name>(.*?)<\/name>\s*<description>(.*?)<\/description>\s*<location>(.*?)<\/location>\s*<\/skill>/gs;
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

  const rankedNames = result.error ? [] : result.names;

  if (result.error) {
    notify(
      `[pi-smart-skills] QMD ${result.error.kind}: ${result.error.detail} — injecting all skills`,
      "warning",
    );
  }

  // Filter global skills by ranked names
  const nameSet = new Set(rankedNames);
  const filteredGlobal = allGlobalSkills.filter((s) => nameSet.has(s.name));

  // Combine: project skills first, then filtered global skills
  const combinedSkills = [...projectSkills, ...filteredGlobal];

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
    if (setsEqual(newTopNSet, cache.topNSet)) {
      // Rebuild prompt from cached ranked names + current system prompt
      const cachedFiltered = allGlobalSkills.filter((s) =>
        cache.rankedNames.includes(s.name)
      );
      const rebuiltSkills = [...projectSkills, ...cachedFiltered];
      const newBlock = buildSkillsBlock(rebuiltSkills);
      return { newPrompt: systemPrompt.replace(fullBlock, newBlock) };
    }
  }

  const newBlock = buildSkillsBlock(combinedSkills);
  const newPrompt = systemPrompt.replace(fullBlock, newBlock);

  state.searchCache = {
    rankedNames,
    topNSet: newTopNSet,
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
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    const config = loadConfig();
    const qmdOk = qmdAvailable();
    const cwd = ctx.cwd ?? process.cwd();

    if (!qmdOk) {
      ctx.ui.notify("[pi-smart-skills] QMD binary not found — will inject all skills", "warning");
    }

    const collections: SkillCollection[] = [];

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

        const res = ensureCollectionForDir(name, resolved, config);
        if (res.ok) {
          collections.push({ name, dirPath: resolved });
        }
      }

      if (collections.length > 0) {
        ctx.ui.notify(
          `[pi-smart-skills] Indexed ${collections.length} skill collection(s): ${collections.map((c) => c.name).join(", ")}`,
          "info",
        );
      }
    }

    const cronTimer = setInterval(() => {
      for (const coll of collections) {
        spawnSync("qmd", ["update", coll.name], {
          encoding: "utf-8",
          timeout: config.qmdTimeoutMs * 2,
        });
      }
    }, config.cronIntervalMs);

    sessionMap.set(ctx, {
      activeCollections: collections,
      searchCache: null,
      config,
      qmdOk,
      cronTimer,
      cwd,
    });
  });

  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    const state = sessionMap.get(ctx);
    if (state) {
      if (state.cronTimer) {
        clearInterval(state.cronTimer);
      }
      sessionMap.delete(ctx);
    }
  });

  pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
    const sp = event.systemPrompt;
    if (!sp || typeof sp !== "string") return undefined;

    const state = sessionMap.get(ctx);
    if (!state) return undefined;

    const notify: NotifyFn = (msg, level) => {
      ctx.ui.notify(msg, level);
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

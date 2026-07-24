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
  cacheTtlMs: number;
  cronIntervalMs: number;
  skillDirectories: string[];
}

const DEFAULT_CONFIG: ExtensionConfig = {
  maxResults: 10,
  promptCharLimit: 60_000,
  stabilityWindow: 3,
  qmdTimeoutMs: 5_000,
  cacheTtlMs: 60_000,
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

const config = loadConfig();

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const COLLECTION_NAME = "pi-smart-skills";
const AGENT_SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

/* ------------------------------------------------------------------ */
/* Skill discovery                                                    */
/* ------------------------------------------------------------------ */

interface DiscoveredSkill {
  name: string;
  description: string;
  location: string;
}

function discoverSkills(): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  if (!fs.existsSync(AGENT_SKILLS_DIR) || !fs.statSync(AGENT_SKILLS_DIR).isDirectory()) {
    return skills;
  }

  try {
    const entries = fs.readdirSync(AGENT_SKILLS_DIR);
    for (const entry of entries) {
      const skillMdPath = path.join(AGENT_SKILLS_DIR, entry, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;
      try {
        const content = fs.readFileSync(skillMdPath, "utf-8");
        skills.push({
          name: entry,
          description: extractDescription(content),
          location: skillMdPath,
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Skip unreadable directory
  }

  return skills;
}

function extractDescription(content: string): string {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*\|?\s*(.+?)\s*$/m);
    if (descMatch) return descMatch[1].trim();
  }

  const lines = content.split("\n");
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
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

function ensureCollection(): boolean {
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

  if (!fs.existsSync(AGENT_SKILLS_DIR)) {
    return false;
  }

  const addResult = spawnSync("qmd", ["collection", "add", COLLECTION_NAME, AGENT_SKILLS_DIR], {
    encoding: "utf-8",
    timeout: config.qmdTimeoutMs,
  });

  if (addResult.error || addResult.status !== 0) {
    return false;
  }

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

interface QmdError {
  kind: "spawn" | "timeout" | "exit" | "parse" | "empty";
  detail: string;
}

function searchQMD(query: string): { names: string[]; error?: QmdError } {
  const result = spawnSync(
    "qmd",
    ["query", COLLECTION_NAME, query, "-n", String(config.maxResults), "--format", "json"],
    {
      encoding: "utf-8",
      timeout: config.qmdTimeoutMs,
    },
  );

  if (result.error) {
    return { names: [], error: { kind: "spawn", detail: result.error.message } };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? "";
    return {
      names: [],
      error: { kind: "exit", detail: `exit ${result.status}${stderr ? ": " + stderr : ""}` },
    };
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
/* Search cache with TTL + stability tracking                         */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  rankedNames: string[];
  topNSet: Set<string>;
  injectedPrompt: string;
  timestamp: number;
}

let searchCache: CacheEntry | null = null;

interface SkillCollection {
  name: string;
  dirPath: string;
  source: 'global' | 'project';
}

let activeCollections: SkillCollection[] = [];

function getCachedOrSearch(query: string): { names: string[]; error?: QmdError } {
  if (searchCache && Date.now() - searchCache.timestamp < config.cacheTtlMs) {
    return { names: searchCache.rankedNames };
  }

  const result = searchQMD(query);
  if (result.names.length > 0) {
    searchCache = {
      rankedNames: result.names,
      topNSet: new Set(result.names.slice(0, config.stabilityWindow)),
      injectedPrompt: "",
      timestamp: Date.now(),
    };
  }
  return result;
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

type NotifyFn = (msg: string, level: "info" | "warn" | "error") => void;

function rewriteSkillsBlock(
  systemPrompt: string,
  userPrompt: string,
  notify: NotifyFn,
): { newPrompt: string } | null {
  const blockMatch = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
  if (!blockMatch) return null;

  const fullBlock = blockMatch[0];
  const allSkills = parseSkillEntries(fullBlock);

  if (userPrompt.length > config.promptCharLimit) {
    notify(
      `[pi-smart-skills] Prompt too long (${userPrompt.length} chars) — injecting all ${allSkills.length} skills`,
      "info",
    );
    return { newPrompt: systemPrompt };
  }

  let result: { names: string[]; error?: QmdError };
  try {
    result = getCachedOrSearch(userPrompt);
  } catch (err) {
    notify(
      `[pi-smart-skills] QMD search error: ${err} — injecting all ${allSkills.length} skills`,
      "warn",
    );
    return { newPrompt: systemPrompt };
  }

  if (result.error) {
    notify(
      `[pi-smart-skills] QMD ${result.error.kind}: ${result.error.detail} — injecting all ${allSkills.length} skills`,
      "warn",
    );
    return { newPrompt: systemPrompt };
  }

  const rankedNames = result.names;
  if (rankedNames.length === 0) {
    notify(
      `[pi-smart-skills] QMD returned no results — injecting all ${allSkills.length} skills`,
      "warn",
    );
    return { newPrompt: systemPrompt };
  }

  const nameSet = new Set(rankedNames);
  const filtered = allSkills.filter((s) => nameSet.has(s.name));

  if (filtered.length === 0) {
    notify(
      `[pi-smart-skills] No ranked skills matched — injecting all ${allSkills.length} skills`,
      "warn",
    );
    return { newPrompt: systemPrompt };
  }

  const newTopNSet = new Set(rankedNames.slice(0, config.stabilityWindow));
  if (searchCache && searchCache.topNSet.size > 0) {
    if (setsEqual(newTopNSet, searchCache.topNSet)) {
      return { newPrompt: searchCache.injectedPrompt };
    }
  }

  const newBlock = buildSkillsBlock(filtered);
  const newPrompt = systemPrompt.replace(fullBlock, newBlock);

  searchCache = {
    rankedNames,
    topNSet: newTopNSet,
    injectedPrompt: newPrompt,
    timestamp: Date.now(),
  };

  notify(
    `[pi-smart-skills] Injected ${filtered.length}/${allSkills.length} skills (top-${config.stabilityWindow}: ${[...newTopNSet].join(", ")})`,
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

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    searchCache = null;

    if (!qmdOk) {
      ctx.ui?.notify("[pi-smart-skills] QMD binary not found — will inject all skills", "warn");
      return;
    }

    try {
      if (!ensureCollection()) {
        ctx.ui?.notify("[pi-smart-skills] Failed to create QMD collection — will inject all skills", "warn");
        return;
      }

      ctx.ui?.notify("[pi-smart-skills] Collection created, performing initial index", "info");
      updateIndex();
    } catch (err) {
      ctx.ui?.notify(`[pi-smart-skills] Init error: ${err} — will inject all skills`, "warn");
    }
  });

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
    console.log(
      `[pi-smart-skills] background indexer started (every ${config.cronIntervalMs / 1_000}s)`,
    );
  }

  pi.on("session_end", async () => {
    if (cronTimer) {
      clearInterval(cronTimer);
      cronTimer = null;
    }
  });

  pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
    const sp = event.systemPrompt;
    if (!sp || typeof sp !== "string") return undefined;

    const notify: NotifyFn = (msg, level) => {
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

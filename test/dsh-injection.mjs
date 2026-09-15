// Checks the pure helpers behind the message-based (dsh) injection path:
//   - resolveQmdStorePath: env > config > npm-global default, tilde expansion
//   - decideInjectionMode: rewrite vs. message vs. null (per config mode)
//   - truncateDescription: word-boundary cut + ellipsis
//   - buildRelevantSkillsMessage: exact rendering, null on empty input
//   - listSkillsInDir: fixture skill directory / missing directory
//
// Transpiles src/extension.ts with the repo's typescript devDep (type-only
// imports are erased, so the emitted ESM has no non-node imports), then
// asserts on the imported module.
//
// Run: node test/dsh-injection.mjs   (exits non-zero on any failure)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const outDir = mkdtempSync(join(tmpdir(), "pi-smart-skills-test-"));
let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok - ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${label}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function checkTrue(label, cond, detail = "") {
  if (cond) {
    console.log(`ok - ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${label}${detail ? `\n  ${detail}` : ""}`);
  }
}

try {
  // tsc may report the pre-existing TS2307 (missing @earendil-works/pi-coding-agent
  // types) — tolerated; what matters is that the JS is emitted.
  try {
    execFileSync(
      "node",
      [
        tscBin,
        "src/extension.ts",
        "--outDir",
        outDir,
        "--module",
        "esnext",
        "--target",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
        // TS7: an explicit file argument refuses to load tsconfig.json without this.
        "--ignoreConfig",
      ],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } catch {
    /* tolerated — see above */
  }

  const mod = await import(join(outDir, "extension.js"));

  // --- resolveQmdStorePath -----------------------------------------------

  check(
    "resolveQmdStorePath: env value wins over config",
    mod.resolveQmdStorePath("/abs/qmd/dist/store.js", { qmdStorePath: "~/other" }),
    "/abs/qmd/dist/store.js",
  );
  check(
    "resolveQmdStorePath: config tilde expands",
    mod.resolveQmdStorePath(undefined, { qmdStorePath: "~/dsh/qmd" }),
    join(process.env.HOME, "dsh", "qmd"),
  );
  check(
    "resolveQmdStorePath: defaults to the npm-global install",
    mod.resolveQmdStorePath(),
    join(process.env.HOME, ".npm-global", "lib", "node_modules", "@tobilu", "qmd", "dist", "store.js"),
  );
  check(
    "resolveQmdStorePath: whitespace-only env falls through to config",
    mod.resolveQmdStorePath("   ", { qmdStorePath: "~/x" }),
    join(process.env.HOME, "x"),
  );

  // --- decideInjectionMode -----------------------------------------------

  const withBlock =
    "head\n<available_skills>\n<skill><name>a</name><description>d</description></skill>\n</available_skills>\ntail";
  const withoutBlock = "just a plain system prompt with no block";
  check("decideInjectionMode: auto + block -> rewrite", mod.decideInjectionMode(withBlock, "auto"), "rewrite");
  check("decideInjectionMode: auto + no block -> message", mod.decideInjectionMode(withoutBlock, "auto"), "message");
  check("decideInjectionMode: explicit rewrite -> rewrite even without block", mod.decideInjectionMode(withoutBlock, "rewrite"), "rewrite");
  check("decideInjectionMode: explicit message -> message even with block", mod.decideInjectionMode(withBlock, "message"), "message");
  check("decideInjectionMode: empty prompt -> null", mod.decideInjectionMode("", "auto"), null);
  check("decideInjectionMode: undefined prompt -> null", mod.decideInjectionMode(undefined, "auto"), null);
  check("decideInjectionMode: unknown mode behaves like auto", mod.decideInjectionMode(withBlock, "bogus"), "rewrite");

  // --- truncateDescription -----------------------------------------------

  check("truncateDescription: short text unchanged", mod.truncateDescription("A short description."), "A short description.");
  check("truncateDescription: empty -> empty", mod.truncateDescription("   "), "");
  {
    const long = "word ".repeat(60).trim();
    const cut = mod.truncateDescription(long, 50);
    const ok =
      cut.length <= 51 &&
      cut.endsWith("…") &&
      !cut.slice(0, -1).endsWith(" ") &&
      long.startsWith(cut.slice(0, -1));
    checkTrue("truncateDescription: long text cut at a word boundary with ellipsis", ok, `got: ${cut}`);
  }

  // --- buildRelevantSkillsMessage -----------------------------------------

  {
    const skills = [
      { name: "alpha", description: "First skill.", location: "/x/alpha/SKILL.md" },
      { name: "beta", description: "", location: "/x/beta/SKILL.md" },
    ];
    const expected = [
      "<system-reminder>",
      "Of this session's 12 available skills, the following 2 are most relevant to this prompt:",
      "",
      "- `alpha` First skill.",
      "- `beta`",
      "",
      "If a listed skill applies, call the `skill` tool with its exact name before acting; its full instructions will load into this conversation.",
      "</system-reminder>",
    ].join("\n");
    check("buildRelevantSkillsMessage: exact rendering", mod.buildRelevantSkillsMessage(skills, 12), expected);
    check("buildRelevantSkillsMessage: empty skill list -> null", mod.buildRelevantSkillsMessage([], 12), null);
  }

  // --- listSkillsInDir ----------------------------------------------------

  {
    const fixture = mkdtempSync(join(tmpdir(), "pi-smart-skills-fix-"));
    try {
      mkdirSync(join(fixture, "s1"), { recursive: true });
      writeFileSync(join(fixture, "s1", "SKILL.md"), "---\nname: s1\ndescription: Fixture skill one.\n---\nbody\n");
      mkdirSync(join(fixture, "s2"), { recursive: true });
      writeFileSync(join(fixture, "s2", "SKILL.md"), "---\nname: s2\ndescription: Fixture skill two.\n---\n");
      mkdirSync(join(fixture, "not-a-skill"), { recursive: true });
      writeFileSync(join(fixture, "not-a-skill", "README.md"), "no skill file here\n");

      const listed = mod.listSkillsInDir(fixture).map((s) => s.name).sort();
      check("listSkillsInDir: fixture dir yields its skills", listed, ["s1", "s2"]);
      check("listSkillsInDir: missing dir -> empty", mod.listSkillsInDir(join(fixture, "does-not-exist")), []);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll dsh-injection checks passed.");

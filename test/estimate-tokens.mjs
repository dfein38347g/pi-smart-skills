// Dependency-free check for estimateTokens (the skills-search trigger guard).
// Transpiles src/extension.ts with the repo's TypeScript devDep (type-only
// imports are erased, so the emitted ESM has no non-node imports), imports the
// result, and asserts the estimator's behavior on trivial vs. real prompts.
//
// Run: node test/estimate-tokens.mjs   (exits non-zero on any failure)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const outDir = mkdtempSync(join(tmpdir(), "pi-smart-skills-test-"));
let failures = 0;

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
        // (Resulting type errors are expected and do not stop emission.)
        "--ignoreConfig",
      ],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } catch {
    /* tolerated — see above */
  }

  const { estimateTokens } = await import(join(outDir, "extension.js"));

  const cases = [
    // trivial / short prompts: below the 5-token trigger threshold
    ["", 0],
    ["ok", 1],
    ["yes", 1],
    ["go", 1],
    ["continue", 2],
    ["yes, continue", 3],
    ["hmm, keep going", 4],
    ["please continue", 4],
    ["continue with the plan", 5], // boundary: 5 is NOT < 5 -> search runs
    // real instructions: comfortably above the threshold
    ["review the diff in this pull request", 9],
    ["proceed with the deployment steps", 9],
    ["run the tests and fix the failing ones", 10],
    // CJK: one token per character
    ["ok", 1],
    ["谢谢", 2],
    ["继续工作", 4],
    ["请帮我审查这段代码", 9],
    ["请继续", 3],
    // mixed script
    ["请 review", 3],
  ];

  for (const [input, expected] of cases) {
    const actual = estimateTokens(input);
    const ok = actual === expected;
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  estimateTokens(${JSON.stringify(input)}) = ${actual}${ok ? "" : ` (expected ${expected})`}`);
  }

  // The semantic contract: trivial prompts skip, real ones don't (threshold 5).
  const trivial = ["continue", "ok", "yes, go ahead", "hmm, keep going", "继续"];
  const real = ["review the diff in this pull request", "请帮我审查这段代码", "proceed with the deployment steps"];
  for (const p of trivial) {
    if (estimateTokens(p) >= 5) {
      failures += 1;
      console.log(`FAIL  trivial prompt ${JSON.stringify(p)} should sit below the 5-token threshold`);
    }
  }
  for (const p of real) {
    if (estimateTokens(p) < 5) {
      failures += 1;
      console.log(`FAIL  real prompt ${JSON.stringify(p)} should clear the 5-token threshold`);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall estimator checks passed");

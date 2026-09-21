#!/usr/bin/env node
/**
 * Keeps SPEC.md and verify.mjs honest about each other.
 *
 * A specification whose requirements drift away from its test suite is back to
 * being prose. This fails if either:
 *
 *   - a requirement is defined in SPEC.md but is neither asserted by verify.mjs
 *     nor listed in SPEC.md §12.4 as untestable, with a reason; or
 *   - verify.mjs asserts an identifier that SPEC.md does not define.
 *
 *   node coverage.mjs           # report and exit non-zero on a gap
 *   node coverage.mjs --list    # also print the full mapping
 */

import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("SPEC.md", import.meta.url), "utf8");
const verifier = readFileSync(new URL("verify.mjs", import.meta.url), "utf8");
const list = process.argv.includes("--list");

// A requirement is DEFINED by a bold identifier at the head of a statement:
//   **[K-GET-3]** ...        or        **[K-GET-3] An unknown document ...**
const defined = new Set([...spec.matchAll(/\*\*\[(K-[A-Z0-9-]+)\]/g)].map((m) => m[1]));

// ASSERTED by the verifier.
const asserted = new Set([...verifier.matchAll(/id:\s*"(K-[A-Za-z0-9-]+)"/g)].map((m) => m[1]));

// Declared untestable in §12.4, which must give a reason in the same row.
const table = spec.split("### 12.4")[1]?.split(/\n## /)[0] ?? "";
const untestable = new Map();
for (const line of table.split("\n")) {
  if (!line.trim().startsWith("|")) continue;
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 4) continue;
  const reason = cells[2];
  if (!reason || /^-+$/.test(reason)) continue;
  const cell = cells[1];
  const ids = [...cell.matchAll(/(K-[A-Z0-9-]+)/g)].map((m) => m[1]);
  for (const id of ids) untestable.set(id, reason);
  // A cell may also name a range: `[K-SYNC-1]` ... `[K-SYNC-6]`. Expand it when
  // an ellipsis separates exactly two ids that share a prefix.
  if (/…|\.\.\./.test(cell) && ids.length === 2) {
    const split = (id) => {
      const m = /^(.*)-(\d+)$/.exec(id);
      return m ? [m[1], Number(m[2])] : null;
    };
    const a = split(ids[0]);
    const b = split(ids[1]);
    if (a && b && a[0] === b[0]) {
      for (let n = Math.min(a[1], b[1]); n <= Math.max(a[1], b[1]); n++) {
        untestable.set(`${a[0]}-${n}`, reason);
      }
    }
  }
}

// An assertion may refine a requirement with a suffix (K-CT-3 -> K-CT-3b), and
// §12.4 may cover a family with a trailing dash (K-SYNC- covers K-SYNC-4).
const assertedFor = (id) => asserted.has(id) || [...asserted].some((a) => a.startsWith(id));
const untestableFor = (id) => {
  if (untestable.has(id)) return untestable.get(id);
  for (const [key, reason] of untestable) {
    if (key.endsWith("-") && id.startsWith(key)) return reason;
  }
  return null;
};

const rows = [];
const gaps = [];
for (const id of [...defined].sort()) {
  if (assertedFor(id)) rows.push([id, "asserted", ""]);
  else {
    const reason = untestableFor(id);
    if (reason) rows.push([id, "untestable", reason]);
    else { rows.push([id, "GAP", ""]); gaps.push(id); }
  }
}

const undefinedIds = [...asserted].filter((a) => !defined.has(a) && ![...defined].some((d) => a.startsWith(d))).sort();

if (list) {
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [id, state, reason] of rows) {
    process.stdout.write(`  ${id.padEnd(w)}  ${state.padEnd(10)}  ${reason.slice(0, 90)}\n`);
  }
  process.stdout.write("\n");
}

const counts = rows.reduce((a, [, s]) => ((a[s] = (a[s] ?? 0) + 1), a), {});
process.stdout.write(
  `SPEC.md defines ${defined.size} requirements: ` +
    `${counts.asserted ?? 0} asserted, ${counts.untestable ?? 0} declared untestable, ${gaps.length} unaccounted for.\n` +
    `verify.mjs makes ${asserted.size} distinct assertions.\n`,
);

let bad = false;
if (gaps.length) {
  bad = true;
  process.stdout.write(`\nRequirements with neither an assertion nor an entry in §12.4:\n`);
  for (const id of gaps) process.stdout.write(`  ${id}\n`);
  process.stdout.write(`\nEither assert them in verify.mjs, or add a row to SPEC.md §12.4 saying why not.\n`);
}
if (undefinedIds.length) {
  bad = true;
  process.stdout.write(`\nAsserted by verify.mjs but not defined in SPEC.md:\n`);
  for (const id of undefinedIds) process.stdout.write(`  ${id}\n`);
  process.stdout.write(`\nAdd a **[${undefinedIds[0]}]** statement to SPEC.md, or rename the assertion.\n`);
}

process.stdout.write(bad ? `\nFAIL\n` : `\nOK — spec and verifier agree.\n`);
process.exit(bad ? 1 : 0);

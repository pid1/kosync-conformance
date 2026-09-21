#!/usr/bin/env node
/**
 * Regenerates the golden files described in SPEC.md §8.6 and checks that the
 * partial-MD5 digests in vectors.json still come out.
 *
 * This is the half of conformance that is not about HTTP. `document` is opaque
 * to a server, so a server never has to compute it -- but every CLIENT does,
 * and two clients that disagree sync nothing while both appearing to work.
 *
 *   node vectors/check.mjs             # synthetic vectors only
 *   node vectors/check.mjs --big       # also the >1 GiB vector (needs a
 *                                      # filesystem with sparse files)
 *   node vectors/check.mjs --koreader DIR
 *                                      # also leaves.epub / tall.pdf from a
 *                                      # checkout of koreader/test-data
 *
 * Exit 0 if every vector matched.
 */

import { createHash } from "node:crypto";
import { openSync, readSync, writeSync, ftruncateSync, closeSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const VECTORS = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));

const args = process.argv.slice(2);
const wantBig = args.includes("--big");
const koreaderDir = args.includes("--koreader") ? args[args.indexOf("--koreader") + 1] : null;

/**
 * The offsets, as LuaJIT evaluates `lshift(1024, 2*i)` for i = -1..10.
 * The first is 0, NOT 256: the shift count -2 is masked to five bits, giving
 * 30, and 1024 << 30 overflows 32 bits to 0. See SPEC.md §8.3.
 */
export const OFFSETS = [
  0, 1024, 4096, 16384, 65536, 262144,
  1048576, 4194304, 16777216, 67108864, 268435456, 1073741824,
];

/** Reference implementation of KOReader's partial MD5, for a file on disk. */
export function partialMd5(path) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  const hash = createHash("md5");
  const buf = Buffer.alloc(1024);
  let samples = 0;
  try {
    for (const offset of OFFSETS) {
      if (offset >= size) break;          // read() would return nil -> break
      const got = readSync(fd, buf, 0, 1024, offset);
      if (got === 0) break;
      hash.update(buf.subarray(0, got));  // last sample truncated, never padded
      samples++;
    }
  } finally {
    closeSync(fd);
  }
  return { digest: hash.digest("hex"), samples, size };
}

/** P(n): byte i is (i * 31 + (i >> 8)) mod 256. SPEC.md §8.6. */
function pattern(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 0xff;
  return b;
}

const dir = mkdtempSync(join(tmpdir(), "kosync-vectors-"));
let pass = 0;
let fail = 0;

function check(name, expected, actual) {
  const ok = expected.digest === actual.digest && expected.samples === actual.samples;
  if (ok) {
    pass++;
    console.log(`  ok   ${name}  ${actual.digest}  (${actual.samples} samples, ${actual.size} B)`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`         expected ${expected.digest} (${expected.samples} samples)`);
    console.log(`         actual   ${actual.digest} (${actual.samples} samples)`);
  }
}

try {
  console.log("\nSynthetic vectors P(n)  --  SPEC.md §8.6");
  for (const v of VECTORS.synthetic) {
    const path = join(dir, `p-${v.size}.bin`);
    const fd = openSync(path, "w");
    writeSync(fd, pattern(v.size));
    closeSync(fd);
    check(`P(${v.size})`, v, partialMd5(path));
  }

  if (wantBig) {
    console.log("\nSparse >1 GiB vector  --  exercises all 12 offsets");
    const v = VECTORS.sparse;
    const path = join(dir, "sparse.bin");
    const fd = openSync(path, "w");
    ftruncateSync(fd, v.size);
    for (const o of OFFSETS) {
      writeSync(fd, Buffer.from(String(o).padStart(16, "0"), "ascii"), 0, 16, o);
    }
    closeSync(fd);
    const st = statSync(path);
    console.log(`       (logical ${st.size} B, ${st.blocks} blocks allocated)`);
    check("sparse 1 GiB + 1024", v, partialMd5(path));
  } else {
    console.log("\nSparse >1 GiB vector: skipped (pass --big to run it)");
  }

  if (koreaderDir) {
    console.log("\nKOReader's own fixtures  --  pinned in koreader spec/unit/util_spec.lua");
    for (const v of VECTORS.koreaderTestData) {
      const path = join(koreaderDir, v.file);
      try {
        check(v.file, v, partialMd5(path));
      } catch (error) {
        fail++;
        console.log(`  FAIL ${v.file}: ${error.message}`);
      }
    }
  } else {
    console.log("\nKOReader fixtures: skipped (pass --koreader <checkout of koreader/test-data>)");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

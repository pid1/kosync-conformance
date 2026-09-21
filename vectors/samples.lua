-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is a verbatim transcription of util.partialMD5 from
-- koreader/frontend/util.lua:1094-1112, which is AGPL-3.0. It is therefore a
-- derivative of that work and is licensed AGPL-3.0-or-later, NOT under the
-- BSD-3-Clause that covers the rest of this repository. See LICENSE-SAMPLES.
--
-- Nothing else here depends on it: vectors/check.mjs carries its own
-- independent implementation, and this file exists only as a second oracle so
-- the golden digests are confirmed by two implementations rather than one.
--
-- The transcription replaces update(sample) with a write of the sample to
-- stdout, so the digest can be taken by an external, trusted MD5.
-- arg[2] = "luajit" (default, evaluates lshift as LuaJIT does)
--        | "arith"  (forces the arithmetic reading, first offset 256)
local bit = require("bit")
local lshift = bit.lshift
local path, variant = arg[1], (arg[2] or "luajit")
local step, size = 1024, 1024
local file = assert(io.open(path, "rb"))
io.stdout:setvbuf("full", 1024*64)
local n, total = 0, 0
local offs = {}
for i = -1, 10 do
    local off = lshift(step, 2*i)
    if variant == "arith" and i == -1 then off = 256 end
    file:seek("set", off)
    local sample = file:read(size)
    if sample then
        io.stdout:write(sample)
        n = n + 1; total = total + #sample
        offs[#offs+1] = string.format("%d:%d", off, #sample)
    else
        break
    end
end
file:close()
io.stderr:write(string.format("variant=%s samples=%d bytes=%d offsets=[%s]\n",
    variant, n, total, table.concat(offs, " ")))

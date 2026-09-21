# Document-hash vectors

`document` — the key a kosync server stores a reading position under — is an
opaque string to the server. Servers never have to compute it. **Clients do**,
and two clients that compute it differently sync nothing while both appearing
to work perfectly.

SPEC.md §8 specifies the algorithm. This directory is the evidence.

| File | What it is |
|---|---|
| `vectors.json` | the golden digests, as data, for implementations in any language |
| `check.mjs` | regenerates the files and checks the digests still come out |
| `samples.lua` | a verbatim transcription of KOReader's loop that emits the sampled bytes, so an implementation can be checked against real LuaJIT |

```bash
node check.mjs                          # synthetic vectors
node check.mjs --big                    # also >1 GiB, exercising all 12 samples
node check.mjs --koreader path/to/koreader-test-data
```

The `--koreader` run is the one that matters. `koreader/test-data` holds
`leaves.epub` and `tall.pdf`, whose partial-MD5 digests are pinned in
KOReader's own `spec/unit/util_spec.lua`. Reproducing those proves the first
sample offset is **0** and not 256 — not by reasoning about LuaJIT's shift
semantics, but by matching the digests KOReader itself asserts.

```bash
luajit samples.lua leaves.epub | md5sum
# 59d481d168cca6267322f150c5f6a2a3
```

Two things that catch implementations out:

- **Twelve samples, not eleven.** The loop is `for i = -1, 10`. One surveyed
  implementation uses an exclusive bound and takes eleven, which is identical
  for every file below 1 GiB and wrong above it.
- **The first offset is 0, not 256.** `lshift(1024, -2)` masks the shift count
  to five bits, giving `1024 << 30`, which overflows 32 bits to zero. C#, Java
  and JavaScript `<<` mask the same way, so a direct transcription is usually
  right by accident. Python and Go do not — `1024 << -2` raises or shifts the
  other way — so those need the masking written out explicitly.

## Do not vendor the KOReader fixtures

`leaves.epub` and `tall.pdf` are supplied by the person running the check, via
`--koreader <checkout of koreader/test-data>`. They are deliberately not committed here:
`koreader/test-data` declares no licence at all, so redistributing those files would be
on far shakier ground than anything else in this repository. The digests of them are
facts and are fine to publish; the files are not ours to ship.

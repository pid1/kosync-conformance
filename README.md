# kosync-conformance

A written specification of the **kosync** protocol — the progress-sync protocol
KOReader speaks — and a conformance verifier that checks a running server
against it.

kosync has had no specification for eight years. The only normative definition
is the source of two programs: KOReader's `kosync.koplugin` and
`koreader/koreader-sync-server`. At least nine independent reimplementations
exist, and they disagree with each other in ways that are invisible until a
user's reading position quietly stops syncing.

- **[`SPEC.md`](SPEC.md)** — the specification. Every claim cites a file and
  line in a pinned commit, or is marked as measured against a running server.
- **[`verify.mjs`](verify.mjs)** — point it at a server, get pass/fail per
  requirement. One file, no dependencies.
- **[`vectors/`](vectors/)** — golden test vectors for the document-hash
  algorithm, with a script that regenerates and checks them.
- **[`reference-server/`](reference-server/)** — how to run the reference
  implementation locally, which was itself undocumented.
- **[`coverage.mjs`](coverage.mjs)** — fails if a requirement in `SPEC.md` has
  neither a test nor a written reason why it cannot have one. Runs in CI, so
  the spec and its test suite cannot drift apart quietly.

This is **not** an official KOReader project and carries no endorsement from
it. It is a description of observed behaviour. Where it and the reference
implementation disagree, the reference is right and this repository has a bug —
please open an issue.

## Check your server

```bash
git clone https://github.com/pid1/kosync-conformance
cd kosync-conformance
node verify.mjs --base-url https://sync.example.com --user alice --password hunter2
```

That is the whole interface: a URL and credentials. Nothing is assumed about
your server's language, storage or hosting.

```
§5.5  GET /syncs/progress/:document
  ok   [K-GET-2] a stored position reads back with 200
  ok   [K-FLD-3] progress round-trips byte-for-byte as a string
 FAIL  [K-GET-3] an UNKNOWN document returns 200, not 404
         expected: 200
         actual:   404 {"status":"not found"}
         note:     the client detects an unread book by the ABSENCE of a
                   percentage field, not by a status code. Any non-200 here is
                   rendered to the user as a sync error instead of 'no progress
                   found'.
         spec:     SPEC.md §5.5
```

Exit `0` when every **MUST** passes, `1` otherwise, `2` if the server could not
be reached. `--json report.json` writes the same thing for CI to gate on.

Requirements are levelled. A **MUST** failure means a stock KOReader client
will misbehave against your server. A **SHOULD** failure means you deviate from
the reference in a way no reference client notices — most often by omitting the
numeric `code` in error bodies. A **MAY** requirement belongs to an optional
feature: the verifier probes for the feature, skips its requirements on a server
that does not implement it, and checks them in full on one that does. Only MUST
decides the exit status.

Full options, profile flags for intentional deviations, and what the verifier
writes to your server: see [Running the verifier](#running-the-verifier) below.

## Results

Measured 2026-09-21. `verify.mjs` against each server, with the profile flags
each one's design calls for.

| Implementation | Version | Passed | MUST failed | SHOULD failed | Verdict |
|---|---|---:|---:|---:|---|
| `koreader/koreader-sync-server` (reference) | `koreader/kosync:latest`, OpenResty 1.29.2.3, gin 0.2.0 | 49 | **0** | 2 | conformant |
| `pid1/tsundoku` | branch `main` | 47 | **0** | 2 | conformant |

tsundoku's run skips the two registration assertions, because it closes kosync
self-registration by design and the run declared `--registration-off`.

The reference server's two SHOULD failures are a genuine defect in it, not a
disagreement about the protocol: `PUT` accepts any document id, while `GET`
routes on `[A-Za-z0-9_]+` only, so an id containing a hyphen or a dot is stored
and can never be read back (SPEC.md §5.5, §14.3). It is recorded as a SHOULD
precisely because the reference fails it — a requirement derived from the
reference cannot be one the reference violates.

Implementations not yet run against the verifier, but surveyed by source for
SPEC.md §11: `crosspoint-reader/crosspoint-sync`, `Cmooon/kosync`,
`nperez0111/koreader-sync`, `jberlyn/kosync-dotnet`, `Kareadita/Kavita`,
`crocodilestick/calibre-web-automated`, `readest/readest`. Pull requests adding
their results are welcome.

## Things the survey turned up

Findings from SPEC.md that are easy to get wrong and hard to notice:

- **An unknown document returns `200 {}`, not `404`.** The client tests for the
  absence of a `percentage` field, not for a status code. Two surveyed servers
  return `404` and `502` respectively; both render a new book as a sync error.
- **The document hash takes twelve samples, and the first offset is 0.** The
  loop runs `i = -1..10` and `lshift(1024, -2)` overflows to `0`, not `256`.
  Proven by reproducing KOReader's own pinned digests for `leaves.epub` and
  `tall.pdf` — see SPEC.md §8.3. One surveyed implementation takes **eleven**
  samples and so diverges on every file of 1 GiB or more.
- **`password` in `POST /users/create` is already an MD5.** A server that
  hashes it again creates accounts that can never log in.
- **Omitting `timestamp` from `GET` inverts the default sync policy** — it
  forces the client onto a percentage comparison, under which a newer position
  *earlier* in a book is classified as backward, and backward sync defaults to
  disabled. The position is silently discarded. SPEC.md §9.1.
- **A non-401 error makes the client retry for four weeks.** KOReader queues
  any failed push that is not a 401. A permanent failure reported as 400 or 500
  becomes a month-long retry loop.
- **Responses are `application/json`, not the vendor media type.** The vendor
  type belongs in the *request's* `Accept` header, where the reference server
  requires it.

## Running the verifier

### Account

| Flag | Meaning |
|---|---|
| `--base-url URL` | root of the server, no trailing path |
| `--user NAME` | account username |
| `--password PASS` | password; the MD5 is computed for you |
| `--key HEX` | `x-auth-key` directly, if you already hold it |
| `--register` | register `--user` first, and exercise the registration success path |
| `--register-only` | register and exit; useful as a CI setup step |
| `--second-user`, `--second-password`, `--second-key` | a second account, enabling the cross-user isolation check `[K-ISO-1]` |

### Profile

A server may deviate on purpose. Declare it, and the affected assertions are
skipped or inverted rather than reported as failures.

| Flag | Meaning |
|---|---|
| `--no-register` | no `POST /users/create` at all |
| `--registration-off` | registration exists but is deliberately disabled |
| `--no-healthcheck` | no `GET /healthcheck` |
| `--strict-accept` | the server is *expected* to require `Accept: application/vnd.koreader.v1+json`, as the reference does |

### Optional features

Optional features are detected, not declared. Each is probed once before the
suites run, and a server that does not implement one has its `MAY` requirements
skipped rather than failed. The JSON report records what was found under
`features`, alongside the per-requirement results.

### Output

| Flag | Meaning |
|---|---|
| `--json FILE` | machine-readable report; gate CI on `.conformant` |
| `--quiet` | only failures and the summary |
| `--timeout MS` | per-request timeout, default 10000 |
| `--document ID` | document id for the round-trip |

### What it writes

The verifier is **not read-only.** It stores reading positions under a handful
of synthetic document ids derived from `--document`. Those ids are constant
across runs by design, so a hundred runs leave five rows rather than five
hundred. Point it at a test account.

It **never probes `DELETE /users/me`**, because a conformant server would
delete the account under test.

### Against the reference implementation

```bash
reference-server/run.sh
node verify.mjs --base-url http://127.0.0.1:8080 \
  --user refuser1 --password refpass1 --register --strict-accept
reference-server/run.sh stop
```

[`reference-server/README.md`](reference-server/README.md) has the details,
including what does and does not work without containers.

## Document-hash vectors

`document` is opaque to a server, so a server never has to compute it. Every
*client* does, and two clients that disagree sync nothing while both appearing
to work.

```bash
node vectors/check.mjs                  # synthetic vectors
node vectors/check.mjs --big            # also the >1 GiB vector, all 12 samples
node vectors/check.mjs --koreader path/to/koreader-test-data
```

[`vectors/vectors.json`](vectors/vectors.json) is the data on its own, for
implementations in other languages. [`vectors/samples.lua`](vectors/samples.lua)
is a verbatim transcription of KOReader's loop that emits the sampled bytes, so
you can check an implementation against real LuaJIT rather than against a
reading of the Lua.

## Contributing

Results for another implementation, corrections, and citations for anything
marked `[unverified]` in SPEC.md are all welcome. The bar for a factual claim is
a file-and-line citation into a pinned commit, or a command someone else can
run.

## Licence

Three licences, because the repository holds three different kinds of thing.

- `SPEC.md` and `vectors/vectors.json`: **CC0-1.0** (`LICENSE-SPEC`). Any implementation can copy from them, including into an AGPL or proprietary codebase, with no attribution obligation. A specification that is awkward to quote does not get adopted.
- `verify.mjs`, `vectors/check.mjs` and the shell scripts: **BSD-3-Clause** (`LICENSE`), so projects can vendor the tests.
- `vectors/samples.lua`: **AGPL-3.0-or-later** (`LICENSE-SAMPLES`). It is a verbatim transcription of `util.partialMD5` from `koreader/frontend/util.lua`, which is AGPL-3.0, so it is a derivative of that work and cannot be relicensed. It is a standalone script that nothing links against, and `vectors/check.mjs` carries its own independent implementation, so the AGPL obligation does not reach the verifier. It exists only so the golden digests are confirmed by two implementations rather than one.

Code quoted inside `SPEC.md` likewise remains under its original licence: AGPL-3.0 for `koreader/koreader` and `koreader/koreader-sync-server`, MIT for `ostinelli/gin`. Those are short excerpts reproduced for description and identification.

The KOReader test fixtures are not redistributed here. See `vectors/README.md`.

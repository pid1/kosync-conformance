# AGENTS.md

## Sadr

### Build and test
- The repo has no package.json and no dependencies. Every check runs on plain Node from the CI setup-node step.
- `node --check verify.mjs && node --check vectors/check.mjs && node --check coverage.mjs` passes when each script parses.
- `node coverage.mjs` passes when it prints "OK — spec and verifier agree."
- `node vectors/check.mjs --big --koreader koreader-test-data` passes with "10 passed, 0 failed". It needs a checkout of koreader/test-data at `koreader-test-data`, and `--big` writes a sparse 1 GiB file under the system temp folder.
- `node verify.mjs --help` exits 2 by design.
- The reference check starts the server with `sh reference-server/run.sh start` (Docker or Podman), registers `ciuser2` as the `reference` job in `.github/workflows/conformance.yml` does, then runs `node verify.mjs --base-url http://127.0.0.1:8080 --user ciuser1 --password cipass1 --register --strict-accept --second-user ciuser2 --second-password secondpass`. It passes when it prints "RESULT: conformant" and exits 0. Stop the server with `sh reference-server/run.sh stop`.
- `sh reference-server/run.sh` reads `KOSYNC_NAME` and `KOSYNC_PORT`, so `KOSYNC_NAME=kosync-sadr KOSYNC_PORT=18080 sh reference-server/run.sh start` runs a second server beside the default one. Stop it with the same `KOSYNC_NAME`.

### Toolchain
- No package manager and no lockfile. CI installs only Node (`actions/setup-node`), the `koreader/kosync` image (a service container, and the default image in `reference-server/run.sh`), and a clone of koreader/test-data.
- CI fetches koreader/test-data at commit c3b5d06e1ae8ea088bd898b0e7f9da3753d0d86c (master on 2024-12-16). The repo has no release tags, and SPEC.md cites that commit.

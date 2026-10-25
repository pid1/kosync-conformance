# AGENTS.md

## Sadr

### Build and test
- The repo has no package.json and no dependencies. Every check runs on plain Node from the CI setup-node step.
- `node --check verify.mjs && node --check vectors/check.mjs && node --check coverage.mjs` passes when each script parses.
- `node coverage.mjs` passes when it prints "OK — spec and verifier agree."
- `node vectors/check.mjs --big --koreader koreader-test-data` passes with "10 passed, 0 failed". It needs a checkout of koreader/test-data at `koreader-test-data`, and `--big` writes a sparse 1 GiB file under the system temp folder.
- `node verify.mjs --help` exits 2 by design.
- The reference check starts the server with `sh reference-server/run.sh start` (Docker or Podman), registers `ciuser2` as the `reference` job in `.github/workflows/conformance.yml` does, then runs `node verify.mjs --base-url http://127.0.0.1:8080 --user ciuser1 --password cipass1 --register --strict-accept --second-user ciuser2 --second-password secondpass`. It passes when it prints "RESULT: conformant" and exits 0. Stop the server with `sh reference-server/run.sh stop`.

### Toolchain
- No package manager and no lockfile. The only tools are Node (CI pins `node-version` in `.github/workflows/conformance.yml`), the `koreader/kosync` image, and the koreader/test-data fixtures that CI fetches by commit.

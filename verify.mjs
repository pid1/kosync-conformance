#!/usr/bin/env node
/**
 * kosync conformance verifier.
 *
 * Points at any kosync server and reports, per requirement identifier, whether
 * it conforms to docs/kosync-protocol.md. Self-contained: Node 18+, no runtime
 * dependencies, no assumption about the server's language, storage or hosting.
 *
 *   node verify.mjs --base-url http://127.0.0.1:8080 --user alice --password s3cret
 *
 * Exit status: 0 if every MUST passed, 1 if any MUST failed, 2 on bad usage or
 * an unreachable server. SHOULD and MAY failures are reported and do not
 * change it.
 *
 * Every assertion cites a requirement id ([K-...]) and a section of the spec.
 * A failure prints what was expected and what actually came back, so the report
 * is actionable without re-running by hand.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const SPEC = "SPEC.md";
const ACCEPT = "application/vnd.koreader.v1+json";

// ---------------------------------------------------------------- arguments

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n\n`);
  process.stderr.write(`kosync conformance verifier

  node verify.mjs --base-url URL (--user U --password P | --user U --key K) [options]

Required
  --base-url URL       root of the kosync server, no trailing path
  --user NAME          account username
  --password PASS      account password; the MD5 is computed for you
  --key HEX            x-auth-key directly, if you already have the MD5

Account bootstrap
  --register           register --user before testing, and test the
                       registration endpoint's success path
  --register-only      register and exit (useful in CI before the real run)
  --second-user NAME   a second existing account, enabling the cross-user
                       isolation check [K-ISO-1]
  --second-password P  password for --second-user
  --second-key HEX     x-auth-key for --second-user

Profile (declare intentional deviations so they are reported as INFO, not FAIL)
  --no-register        server has no POST /users/create at all
  --registration-off   server has registration deliberately disabled
  --no-healthcheck     server has no GET /healthcheck
  --strict-accept      server is expected to REQUIRE the Accept header

Optional features
  Detected, not declared. Each is probed once before the suites run, and a
  feature the server does not implement has its requirements skipped rather
  than failed. There is no flag to set.

Output
  --json FILE          write the machine-readable report to FILE
  --quiet              only print failures and the summary
  --timeout MS         per-request timeout, default 10000
  --document ID        document id for the round-trip. Default is a stable
                       32-char alphanumeric id, so repeat runs overwrite one
                       row and the reference server can route it (see K-GET-1).
`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { timeout: 10000, document: "kosyncconformanceprobe0000000001" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) usage(`${a} needs a value`);
    return v;
  };
  switch (a) {
    case "--base-url": opts.baseUrl = next(); break;
    case "--user": opts.user = next(); break;
    case "--password": opts.password = next(); break;
    case "--key": opts.key = next(); break;
    case "--second-user": opts.secondUser = next(); break;
    case "--second-password": opts.secondPassword = next(); break;
    case "--second-key": opts.secondKey = next(); break;
    case "--json": opts.json = next(); break;
    case "--timeout": opts.timeout = Number(next()); break;
    case "--document": opts.document = next(); break;
    case "--register": opts.register = true; break;
    case "--register-only": opts.register = true; opts.registerOnly = true; break;
    case "--no-register": opts.noRegister = true; break;
    case "--registration-off": opts.registrationOff = true; break;
    case "--no-healthcheck": opts.noHealthcheck = true; break;
    case "--strict-accept": opts.strictAccept = true; break;
    case "--quiet": opts.quiet = true; break;
    case "-h": case "--help": usage(); break;
    default: usage(`unknown option ${a}`);
  }
}

if (!opts.baseUrl) usage("--base-url is required");
if (!opts.user) usage("--user is required");
if (!opts.password && !opts.key) usage("one of --password or --key is required");

const md5 = (s) => createHash("md5").update(s).digest("hex");

const BASE = opts.baseUrl.replace(/\/+$/, "");
const USER = opts.user;
const KEY = (opts.key ?? md5(opts.password)).toLowerCase();
const USER2 = opts.secondUser;
const KEY2 = USER2 ? (opts.secondKey ?? (opts.secondPassword && md5(opts.secondPassword))) : undefined;

// ----------------------------------------------------------------- features

/**
 * A MAY requirement belongs to an optional feature. Each feature registers a
 * probe; the probe runs once, before the suites, and decides whether the
 * server is held to the feature or skips it.
 *
 * Detection rather than declaration, because a server that has to be described
 * to the verifier to be scored correctly will be described wrongly, and the
 * resulting page of failures says nothing about the server.
 *
 *   key           short identifier, used in the report and in `--json`
 *   title         what the feature is, in a noun phrase
 *   section       the section of SPEC.md that defines it
 *   requirements  the identifier prefix its requirements share
 *   probe         async, returns a boolean or { present, note }
 */
const features = new Map();

function feature({ key, title, section, requirements, probe }) {
  features.set(key, { key, title, section, requirements, probe, present: undefined, note: undefined });
}

async function probeFeatures() {
  if (features.size === 0) return;
  section("Optional features");
  for (const f of features.values()) {
    let outcome;
    try {
      outcome = await f.probe();
    } catch (error) {
      // A feature that cannot be detected cannot be required.
      outcome = { present: false, note: `probe failed: ${error?.message ?? error}` };
    }
    if (isObject(outcome)) {
      f.present = !!outcome.present;
      f.note = outcome.note;
    } else {
      f.present = !!outcome;
    }
    if (opts.quiet) continue;
    process.stdout.write(`${f.present ? "  yes " : "  no  "} [${f.key}] ${f.title}\n`);
    process.stdout.write(`         ${SPEC} ${f.section}\n`);
    if (f.note) process.stdout.write(`         ${f.note}\n`);
  }
}

// ------------------------------------------------------------------ results

const results = [];
let networkFailures = 0;

/**
 * Record one assertion.
 *
 * level  MUST   a conformant server has to satisfy this; failure sets exit 1
 *        SHOULD recommended; failure is reported but does not fail the run
 *        MAY    part of an optional feature. A server that does not implement
 *               the feature skips the whole family; one that does is held to
 *               it, and a failure is reported without failing the run
 *        INFO   observation only, never fails
 *
 * `feature` names a registered optional feature, and turns the assertion into
 * a SKIP on a server the probe found does not implement it.
 */
function assert({ id, section, level, title, ok, expected, actual, skip, note, feature: featureKey }) {
  // An identifier under a feature's prefix belongs to that feature whether or
  // not the call site says so. Without this, one omitted `feature` charges a
  // server for an option it never claimed.
  const owner = [...features.values()].find((f) => f.requirements && id.startsWith(f.requirements));
  if (owner && featureKey !== owner.key) throw new Error(`${id} belongs to the feature "${owner.key}" and must say so`);
  if (featureKey !== undefined) {
    const f = features.get(featureKey);
    if (!f) throw new Error(`${id} names the unregistered feature "${featureKey}"`);
    if (f.present === undefined) throw new Error(`${id} ran before "${featureKey}" was probed`);
    if (!f.present && !skip) {
      skip = true;
      note = `not implemented here, and ${SPEC} ${f.section} makes ${f.title} optional`;
    }
  }
  const status = skip ? "SKIP" : ok ? "PASS" : level === "INFO" ? "INFO" : "FAIL";
  results.push({ id, section, level, title, status, expected, actual, note });
  if (opts.quiet && (status === "PASS" || status === "SKIP")) return;
  const mark = { PASS: "  ok  ", FAIL: " FAIL ", SKIP: " skip ", INFO: " info " }[status];
  process.stdout.write(`${mark} [${id}] ${title}\n`);
  if (status === "FAIL" || (status === "INFO" && note)) {
    if (expected !== undefined) process.stdout.write(`         expected: ${fmt(expected)}\n`);
    if (actual !== undefined) process.stdout.write(`         actual:   ${fmt(actual)}\n`);
    if (note) process.stdout.write(`         note:     ${note}\n`);
    process.stdout.write(`         spec:     ${SPEC} ${section}\n`);
  } else if (status === "SKIP" && note) {
    process.stdout.write(`         ${note}\n`);
  }
}

function fmt(v) {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return String(v);
  }
}

function section(title) {
  if (!opts.quiet) process.stdout.write(`\n${title}\n`);
}

// -------------------------------------------------------------------- HTTP

/**
 * One request. Never throws: a transport failure becomes a result object with
 * `error` set, so an assertion can report "the server did not answer" rather
 * than the whole run dying on the first timeout.
 */
async function call(method, path, { headers = {}, body, auth = true, accept = ACCEPT } = {}) {
  const h = {};
  if (accept !== null) h["accept"] = accept;
  if (auth) {
    h["x-auth-user"] = USER;
    h["x-auth-key"] = KEY;
  }
  if (body !== undefined) h["content-type"] = "application/json";
  Object.assign(h, headers);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      headers: response.headers,
      text,
      json,
      ms: Date.now() - started,
    };
  } catch (error) {
    networkFailures++;
    return { error: error.name === "AbortError" ? `timeout after ${opts.timeout}ms` : String(error.message ?? error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// -------------------------------------------------------------------- suite

async function main() {
  process.stdout.write(`kosync conformance verifier\n`);
  process.stdout.write(`  target : ${BASE}\n`);
  process.stdout.write(`  user   : ${USER}\n`);
  process.stdout.write(`  spec   : ${SPEC}\n`);

  // --- Bootstrap. Registration has to happen before ANY authenticated
  // assertion, or every one of them fails 401 for a reason that has nothing to
  // do with the requirement it is checking. The response is stashed and
  // asserted later, in §5.2, where it reads in order.
  let registerResponse;
  if (opts.register) {
    registerResponse = await call("POST", "/users/create", {
      auth: false,
      body: { username: USER, password: KEY },
    });
  }

  // --- reachability. Bail early and loudly rather than emitting 40 failures.
  const probe = await call("GET", "/users/auth");
  if (probe.error && networkFailures > 0) {
    const probe2 = await call("GET", "/healthcheck", { auth: false });
    if (probe2.error) {
      process.stderr.write(`\nfatal: ${BASE} did not answer (${probe.error}).\n`);
      process.stderr.write(`No assertions were run.\n`);
      process.exit(2);
    }
  }

  // --- Optional features, before the suites, so an assertion anywhere below
  // already knows whether the server implements the one it belongs to.
  await probeFeatures();

  // ===================================================== 3. transport
  section("§3  Transport and framing");

  assert({
    id: "K-URL-2", section: "§3.1", level: "INFO",
    title: "transport is TLS",
    ok: BASE.startsWith("https://"),
    expected: "https://…",
    actual: BASE.split("://")[0] + "://",
    note: BASE.startsWith("https://")
      ? undefined
      : "credentials are sent in plaintext headers on every request; a non-TLS deployment exposes the account's MD5. Not a failure when testing against localhost.",
  });

  {
    const r = await call("GET", "/users/auth", { accept: null });
    if (opts.strictAccept) {
      assert({
        id: "K-ACC-2", section: "§3.3", level: "MUST",
        title: "a request without the vendor Accept header is rejected with 412",
        ok: r.status === 412 && (r.json?.code === 100 || r.json?.code === 101),
        expected: "412 with {code:100} (header absent) or {code:101} (header present but not matching)",
        actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
        note: r.json?.code === 101
          ? "code 101, not 100 — no HTTP client can actually omit Accept: fetch and curl both send a default (*/*), so the reference server sees a header that does not match and answers 101. Code 100 is effectively unreachable in the field."
          : undefined,
      });
    } else {
      assert({
        id: "K-ACC-3", section: "§3.3", level: "SHOULD",
        title: "a request without an Accept header is still served",
        ok: r.status === 200,
        expected: "200 (relaxing the reference server's 412/100 is permitted and safe)",
        actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
        note: r.status === 412
          ? "server enforces the reference behaviour; re-run with --strict-accept to assert it positively"
          : undefined,
      });
    }
  }

  {
    // The vendor type must be accepted, whether or not it is required.
    const r = await call("GET", "/users/auth");
    assert({
      id: "K-ACC-1", section: "§3.3", level: "MUST",
      title: `Accept: ${ACCEPT} is accepted`,
      ok: r.status === 200,
      expected: "200",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
    });
  }

  {
    const r = await call("PUT", "/syncs/progress", {
      headers: { "content-type": "text/plain" },
      body: { document: `${opts.document}_ct`, progress: "1", percentage: 0.1, device: "conformance" },
    });
    assert({
      id: "K-CT-2", section: "§3.4", level: "SHOULD",
      title: "a request is not rejected on Content-Type grounds",
      ok: r.status === 200,
      expected: "200 — the reference server never inspects request Content-Type",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status === 415 || r.status === 400
        ? "a strict Content-Type gate breaks clients that send none; see §11.3"
        : undefined,
    });
  }

  {
    const r = await call("PUT", "/syncs/progress", { body: "[1,2,3]" });
    assert({
      id: "K-BODY-1", section: "§3.5", level: "SHOULD",
      title: "a JSON array body is rejected",
      ok: r.status >= 400 && r.status < 500,
      expected: "4xx (the reference server answers 400 code 104)",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
    });
  }

  {
    const r = await call("GET", "/users/auth");
    const ct = (r.contentType ?? "").toLowerCase();
    assert({
      id: "K-CT-3", section: "§3.6", level: "MUST",
      title: "responses carry a JSON media type",
      ok: ct.includes("json"),
      expected: "application/json or application/vnd.koreader.v1+json",
      actual: r.error ?? (ct || "(none)"),
    });
    assert({
      id: "K-CT-3b", section: "§3.6", level: "INFO",
      title: "which JSON media type is used",
      ok: true,
      actual: ct || "(none)",
      note: ct.includes("vnd.koreader")
        ? "vendor type; the reference server sends application/json. Both are fine — clients do not dispatch on it."
        : "application/json, matching the reference server.",
    });
  }

  {
    const r = await call("GET", "/syncs/progress");   // no :document segment
    assert({
      id: "K-URL-3", section: "§3.2", level: "MUST",
      title: "a path outside the protocol is not routed",
      ok: r.status === 404 || r.status === 405,
      expected: "404 or 405",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status === 200
        ? "GET /syncs/progress with no document segment was served; the protocol defines no such route"
        : undefined,
    });
  }

  // ===================================================== 4. authentication
  section("§4  Authentication");

  {
    const r = await call("GET", "/users/auth");
    assert({
      id: "K-AUTH-7", section: "§5.3", level: "MUST",
      title: 'valid credentials return 200 {"authorized":"OK"}',
      ok: r.status === 200 && r.json?.authorized === "OK",
      expected: '200 with {"authorized":"OK"}',
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
    });
  }

  for (const [name, headers] of [
    ["no credential headers at all", { "x-auth-user": undefined, "x-auth-key": undefined }],
    ["a wrong x-auth-key", { "x-auth-key": md5(`definitely-not-the-password-${Date.now()}`) }],
    ["an unknown username", { "x-auth-user": `no-such-user-${Date.now()}` }],
  ]) {
    const h = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const stripAuth = headers["x-auth-user"] === undefined && headers["x-auth-key"] === undefined;
    const r = await call("GET", "/users/auth", { auth: !stripAuth, headers: h });
    assert({
      id: "K-AUTH-6", section: "§4", level: "MUST",
      title: `${name} returns 401`,
      ok: r.status === 401,
      expected: "401",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status && r.status !== 401
        ? "the client retries any non-401 failure from a queue for four weeks (§6.4); a permanent failure must be 401"
        : undefined,
    });
  }

  {
    const r = await call("GET", "/users/auth", { headers: { "x-auth-key": md5(`bad-${Date.now()}`) } });
    assert({
      id: "K-ERR-1", section: "§6", level: "SHOULD",
      title: "an error body is {code, message}",
      ok: isObject(r.json) && typeof r.json.code === "number" && typeof r.json.message === "string",
      expected: '{"code":2001,"message":"Unauthorized"}',
      actual: r.error ?? fmt(r.json ?? r.text),
      note: isObject(r.json) && r.json.code === undefined
        ? "no numeric code; the reference client never reads it, but other clients and operators do. See §11.8."
        : undefined,
    });
    assert({
      id: "K-ERR-2001", section: "§6.1", level: "SHOULD",
      title: "an authentication failure carries code 2001",
      ok: r.json?.code === 2001,
      expected: "2001",
      actual: r.error ?? fmt(r.json?.code ?? r.json ?? r.text),
    });
  }

  {
    // The reference server treats the key as opaque bytes, so uppercase hex is
    // a DIFFERENT credential. Either answer is defensible; record which.
    const r = await call("GET", "/users/auth", { headers: { "x-auth-key": KEY.toUpperCase() } });
    assert({
      id: "K-AUTH-3", section: "§4", level: "INFO",
      title: "how uppercase-hex x-auth-key is treated",
      ok: true,
      actual: r.error ?? `${r.status}`,
      note: r.status === 200
        ? "accepted — the server normalises hex case. More forgiving than the reference, which compares raw bytes and would answer 401."
        : "rejected — matches the reference server's byte-exact comparison.",
    });
  }

  {
    const r = await call("GET", "/users/auth", { headers: { "x-auth-key": "not-32-hex-characters" } });
    assert({
      id: "K-AUTH-5", section: "§4", level: "INFO",
      title: "whether x-auth-key is required to look like an MD5",
      ok: true,
      actual: r.error ?? `${r.status}`,
      note: "the reference server accepts any non-empty key string; enforcing 32 hex chars is stricter and would reject an account registered with a non-MD5 key.",
    });
  }

  // ===================================================== 5.1 healthcheck
  section("§5.1  GET /healthcheck");

  if (opts.noHealthcheck) {
    assert({ id: "K-HC-1", section: "§5.1", level: "MUST", title: 'healthcheck returns {"state":"OK"}', skip: true, note: "--no-healthcheck declared" });
  } else {
    const r = await call("GET", "/healthcheck", { auth: false });
    assert({
      id: "K-HC-1", section: "§5.1", level: "SHOULD",
      title: 'GET /healthcheck returns 200 {"state":"OK"}',
      ok: r.status === 200 && r.json?.state === "OK",
      expected: '200 {"state":"OK"}',
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
    });
  }

  // ===================================================== 5.2 registration
  section("§5.2  POST /users/create");

  if (opts.noRegister) {
    assert({ id: "K-REG-2", section: "§5.2", level: "MUST", title: "registration success path", skip: true, note: "--no-register declared" });
    assert({ id: "K-REG-3", section: "§5.2", level: "MUST", title: "duplicate username returns 402 code 2002", skip: true, note: "--no-register declared" });
    assert({ id: "K-REG-5", section: "§5.2", level: "MUST", title: "registration-disabled returns 402 code 2005", skip: true, note: "--no-register declared" });
  } else if (opts.registrationOff) {
    const r = await call("POST", "/users/create", {
      auth: false,
      body: { username: `probe-${Date.now()}`, password: md5("x") },
    });
    assert({
      id: "K-REG-5", section: "§5.2", level: "SHOULD",
      title: "registration-disabled returns 402 with code 2005",
      ok: r.status === 402 && r.json?.code === 2005,
      expected: "402 with {code:2005}",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status === 403
        ? "403 is the most common third-party answer, but no reference client expects it; see §11.2"
        : undefined,
    });
    assert({ id: "K-REG-2", section: "§5.2", level: "MUST", title: "registration success path", skip: true, note: "--registration-off declared" });
    assert({ id: "K-REG-3", section: "§5.2", level: "MUST", title: "duplicate username returns 402 code 2002", skip: true, note: "--registration-off declared" });
  } else {
    if (opts.register) {
      const r = registerResponse;
      assert({
        id: "K-REG-2", section: "§5.2", level: "MUST",
        title: 'registering a new account returns 201 {"username":…}',
        ok: r.status === 201 && r.json?.username === USER,
        expected: `201 with {"username":"${USER}"}`,
        actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
        note: r.status === 402 ? "account already existed; re-run with a fresh --user to exercise the success path" : undefined,
      });
      // The observable consequence of [K-REG-1]: the key sent at registration
      // is the key that authenticates. A server that re-hashes `password` on
      // the assumption that it is plaintext fails here.
      const auth = await call("GET", "/users/auth");
      assert({
        id: "K-REG-1", section: "§5.2", level: "MUST",
        title: "the key used to register is the key that authenticates",
        ok: auth.status === 200,
        expected: "200 — `password` in /users/create is already md5(plaintext), not a plaintext password",
        actual: auth.error ?? `${auth.status} ${fmt(auth.json ?? auth.text)}`,
        note: auth.status === 401
          ? "the server most likely hashed the already-hashed `password` again; accounts created this way can never log in"
          : undefined,
      });
    } else {
      assert({ id: "K-REG-2", section: "§5.2", level: "MUST", title: "registration success path", skip: true, note: "pass --register to exercise it" });
      assert({ id: "K-REG-1", section: "§5.2", level: "MUST", title: "the key used to register is the key that authenticates", skip: true, note: "pass --register to exercise it" });
    }

    const dup = await call("POST", "/users/create", { auth: false, body: { username: USER, password: KEY } });
    assert({
      id: "K-REG-3", section: "§5.2", level: "SHOULD",
      title: "a duplicate username returns 402 with code 2002",
      ok: dup.status === 402 && dup.json?.code === 2002,
      expected: "402 with {code:2002}",
      actual: dup.error ?? `${dup.status} ${fmt(dup.json ?? dup.text)}`,
    });

    const bad = await call("POST", "/users/create", { auth: false, body: { username: "", password: "" } });
    assert({
      id: "K-REG-4", section: "§5.2", level: "SHOULD",
      title: "an empty username or password returns 403 with code 2003",
      ok: bad.status === 403 && bad.json?.code === 2003,
      expected: "403 with {code:2003}",
      actual: bad.error ?? `${bad.status} ${fmt(bad.json ?? bad.text)}`,
    });

    const colon = await call("POST", "/users/create", { auth: false, body: { username: "has:colon", password: md5("x") } });
    assert({
      id: "K-AUTH-4", section: "§4", level: "SHOULD",
      title: "a username containing a colon is rejected",
      ok: colon.status === 403,
      expected: "403 with {code:2003}",
      actual: colon.error ?? `${colon.status} ${fmt(colon.json ?? colon.text)}`,
      note: "a colon lets a Redis-backed server's key interpolation be escaped; the reference server forbids it in usernames and document ids",
    });
  }

  if (opts.registerOnly) return finish();

  // ===================================================== 5.4 / 5.5 progress
  section("§5.4  PUT /syncs/progress");

  const DOC = opts.document;
  const XPOINTER = "/body/DocFragment[11]/body/div/p[7]/text().123";
  const PCT = 0.4213;

  let putBody;
  {
    const r = await call("PUT", "/syncs/progress", {
      body: {
        document: DOC,
        progress: XPOINTER,
        percentage: PCT,
        device: "kosync-conformance",
        device_id: "conformance-device-1",
      },
    });
    putBody = r.json;
    assert({
      id: "K-PUT-3", section: "§5.4", level: "MUST",
      title: "a valid push returns 200",
      ok: r.status === 200,
      expected: "200",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
    });
    assert({
      id: "K-PUT-3b", section: "§5.4", level: "MUST",
      title: "the push response echoes {document, timestamp}",
      ok: r.json?.document === DOC && typeof r.json?.timestamp === "number",
      expected: `{"document":"${DOC}","timestamp":<integer>}`,
      actual: r.error ?? fmt(r.json ?? r.text),
      note: r.json && typeof r.json.timestamp === "string"
        ? "timestamp is a string; the reference server returns an integer and at least one implementation returns ISO-8601 here but seconds on GET (§11.5)"
        : undefined,
    });
    assert({
      id: "K-SYNC-7", section: "§9.2", level: "MUST",
      title: "the push answered inside the client's 5 s read timeout",
      ok: r.ms !== undefined && r.ms < 5000,
      expected: "< 5000 ms",
      actual: `${r.ms} ms`,
      note: "KOReader sets PROGRESS_TIMEOUTS = {2, 5}; a slower answer is a failed push that gets queued for retry",
    });
    assert({
      id: "K-PUT-7", section: "§5.4", level: "MUST",
      title: "the server does not emit 202",
      ok: r.status !== 202,
      expected: "not 202 — api.json declares it but no client treats it as success",
      actual: r.error ?? `${r.status}`,
    });
  }

  {
    const now = Math.floor(Date.now() / 1000);
    const ts = putBody?.timestamp;
    assert({
      id: "K-FLD-14", section: "§7.7", level: "MUST",
      title: "timestamp is Unix epoch SECONDS, not milliseconds",
      ok: typeof ts === "number" && Math.abs(ts - now) < 86400,
      expected: `within a day of ${now} (epoch seconds)`,
      actual: ts === undefined ? "(absent)" : String(ts),
      note: typeof ts === "number" && ts > now * 100
        ? "this looks like milliseconds. The client compares it against a device-local os.time() in seconds, so every remote position will look newer forever (§9)"
        : undefined,
    });
  }

  {
    // The client never sends a timestamp, but a buggy or third-party one might.
    // The server's clock must win, or conflict resolution is under the control
    // of whichever device has the most optimistic clock.
    const tsDoc = `${opts.document}_ts`;
    const bogus = 1000000000; // 2001-09-09, comfortably in the past
    const put = await call("PUT", "/syncs/progress", {
      body: {
        document: tsDoc, progress: "1", percentage: 0.5,
        device: "conformance", device_id: "t", timestamp: bogus,
      },
    });
    const get = await call("GET", `/syncs/progress/${tsDoc}`);
    const stored = get.json?.timestamp;
    assert({
      id: "K-PUT-4", section: "§5.4", level: "MUST",
      title: "a client-supplied timestamp is ignored; the server generates its own",
      ok: put.status === 200 && typeof stored === "number" && stored !== bogus,
      expected: `a server-generated timestamp, not the ${bogus} that was sent`,
      actual: put.error ?? get.error ?? `PUT ${put.status}, stored timestamp ${fmt(stored)}`,
      note: stored === bogus
        ? "the server stored the client's timestamp. A device with a wrong clock can then pin itself as permanently newest or permanently oldest for every other device (§9)."
        : undefined,
    });
  }

  section("§5.5  GET /syncs/progress/:document");

  {
    const r = await call("GET", `/syncs/progress/${encodeURIComponent(DOC)}`);
    assert({
      id: "K-GET-2", section: "§5.5", level: "MUST",
      title: "a stored position reads back with 200",
      ok: r.status === 200,
      expected: "200",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
    });
    assert({
      id: "K-FLD-3", section: "§7.2", level: "MUST",
      title: "progress round-trips byte-for-byte as a string",
      ok: r.json?.progress === XPOINTER,
      expected: JSON.stringify(XPOINTER),
      actual: r.error ?? fmt(r.json?.progress),
      note: typeof r.json?.progress === "number"
        ? "progress was coerced to a number; this destroys every EPUB XPointer"
        : undefined,
    });
    assert({
      id: "K-FLD-4", section: "§7.3", level: "MUST",
      title: "percentage round-trips as a number in [0,1]",
      ok: typeof r.json?.percentage === "number" && Math.abs(r.json.percentage - PCT) < 1e-6,
      expected: String(PCT),
      actual: r.error ?? fmt(r.json?.percentage),
      note: typeof r.json?.percentage === "number" && Math.abs(r.json.percentage - PCT * 100) < 1e-4
        ? "the value came back scaled by 100; at least one implementation stores 0-100 internally (§11)"
        : undefined,
    });
    assert({
      id: "K-FLD-6", section: "§7.4", level: "MUST",
      title: "device round-trips",
      ok: r.json?.device === "kosync-conformance",
      expected: '"kosync-conformance"',
      actual: r.error ?? fmt(r.json?.device),
    });
    assert({
      id: "K-FLD-7", section: "§7.5", level: "SHOULD",
      title: "device_id round-trips",
      ok: r.json?.device_id === "conformance-device-1",
      expected: '"conformance-device-1"',
      actual: r.error ?? fmt(r.json?.device_id),
      note: r.json && r.json.device_id === undefined
        ? "without device_id the client cannot tell its own pushes apart from a peer's (§7.5)"
        : undefined,
    });
    assert({
      id: "K-FLD-13", section: "§7.7", level: "MUST",
      title: "GET includes timestamp",
      ok: typeof r.json?.timestamp === "number",
      expected: "an integer timestamp field",
      actual: r.error ?? fmt(r.json?.timestamp),
      note: r.json && r.json.timestamp === undefined
        ? "omitting it forces the client onto the percentage fallback, which INVERTS the default sync policy: a newer position earlier in the book is classified as backward, and sync_backward defaults to DISABLE, so it is silently discarded (§9.1)"
        : undefined,
    });
    assert({
      id: "K-GET-2b", section: "§5.5", level: "SHOULD",
      title: "GET echoes the document id",
      ok: r.json?.document === DOC,
      expected: JSON.stringify(DOC),
      actual: r.error ?? fmt(r.json?.document),
      note: "the reference server does echo it, but at least one client deliberately does not rely on this",
    });
  }

  {
    const unknown = `kosyncconformanceneverseen${Date.now()}`;
    const r = await call("GET", `/syncs/progress/${unknown}`);
    assert({
      id: "K-GET-3", section: "§5.5", level: "MUST",
      title: "an UNKNOWN document returns 200, not 404",
      ok: r.status === 200,
      expected: "200",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status === 404 || r.status === 400 || r.status === 502
        ? "the client detects an unread book by the ABSENCE of a percentage field, not by a status code. Any non-200 here is rendered to the user as a sync error instead of 'no progress found'."
        : undefined,
    });
    assert({
      id: "K-GET-3b", section: "§5.5", level: "MUST",
      title: "an unknown document's body has no percentage field",
      ok: isObject(r.json) && r.json.percentage === undefined,
      expected: "{} (or at least: no percentage key)",
      actual: r.error ?? fmt(r.json ?? r.text),
    });
  }

  section("§5.4  Field validation");

  {
    const r = await call("PUT", "/syncs/progress", {
      body: { progress: "1", percentage: 0.5, device: "conformance" },
    });
    assert({
      id: "K-PUT-1", section: "§5.4", level: "SHOULD",
      title: "a missing document is rejected with 403 code 2004",
      ok: r.status === 403 && r.json?.code === 2004,
      expected: "403 with {code:2004}",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status >= 400 && r.status < 500 && r.status !== 403
        ? "rejected, but with a different status than the reference; a client cannot distinguish this from other 4xx"
        : r.status === 200 ? "ACCEPTED — a progress row with no document id was created" : undefined,
    });
  }

  {
    const r = await call("PUT", "/syncs/progress", { body: { document: `${DOC}_partial` } });
    assert({
      id: "K-PUT-2", section: "§5.4", level: "SHOULD",
      title: "a push missing percentage, progress and device is rejected with 403 code 2003",
      ok: r.status === 403 && r.json?.code === 2003,
      expected: "403 with {code:2003}",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status === 200
        ? "accepted. More permissive than the reference; harmless for KOReader, which always sends all four, but it lets a buggy client store an empty position."
        : undefined,
    });
  }

  {
    // percentage 0 is legal: tonumber(0) is truthy in Lua.
    const doc0 = `${DOC}_zero`;
    const put = await call("PUT", "/syncs/progress", {
      body: { document: doc0, progress: "1", percentage: 0, device: "conformance", device_id: "d" },
    });
    const get = await call("GET", `/syncs/progress/${doc0}`);
    assert({
      id: "K-PUT-2b", section: "§5.4", level: "MUST",
      title: "percentage 0 is a legal value, not a missing field",
      ok: put.status === 200 && get.json?.percentage === 0,
      expected: "200, then percentage 0 on read-back",
      actual: put.error ?? `PUT ${put.status}; GET percentage=${fmt(get.json?.percentage)}`,
    });
  }

  section("§5.4  Overwrite and metadata");

  {
    const r1 = await call("PUT", "/syncs/progress", {
      body: { document: DOC, progress: "200", percentage: 0.9, device: "device-b", device_id: "b" },
    });
    const r2 = await call("PUT", "/syncs/progress", {
      body: { document: DOC, progress: "10", percentage: 0.1, device: "device-c", device_id: "c" },
    });
    const g = await call("GET", `/syncs/progress/${DOC}`);
    assert({
      id: "K-PUT-5", section: "§5.4", level: "MUST",
      title: "last write wins, even when it moves backwards",
      ok: r1.status === 200 && r2.status === 200 && g.json?.progress === "10" && g.json?.device === "device-c",
      expected: '{"progress":"10","device":"device-c"}',
      actual: g.error ?? fmt(g.json),
      note: g.json?.progress === "200"
        ? "the server kept the higher position. All conflict resolution belongs on the client (§9); a server that refuses to move backwards makes re-reading impossible."
        : undefined,
    });
  }

  {
    const metaDoc = `${DOC}_meta`;
    const withMeta = await call("PUT", "/syncs/progress", {
      body: {
        document: metaDoc, progress: "5", percentage: 0.2, device: "conformance", device_id: "m",
        metadata: { filename: "leaves.epub", title: "Leaves of Grass", authors: "Walt Whitman" },
      },
    });
    assert({
      id: "K-FLD-10", section: "§7.6", level: "MUST",
      title: "a metadata object is accepted without failing the request",
      ok: withMeta.status === 200,
      expected: "200 — the reference server accepts it and silently drops it",
      actual: withMeta.error ?? `${withMeta.status} ${fmt(withMeta.json ?? withMeta.text)}`,
    });

    const withoutMeta = await call("PUT", "/syncs/progress", {
      body: { document: metaDoc, progress: "6", percentage: 0.3, device: "conformance", device_id: "m" },
    });
    const g = await call("GET", `/syncs/progress/${metaDoc}`);
    assert({
      id: "K-FLD-11", section: "§7.6", level: "MUST",
      title: "a later push that omits metadata still stores the position",
      ok: withoutMeta.status === 200 && Math.abs((g.json?.percentage ?? 0) - 0.3) < 1e-6,
      expected: "200, percentage 0.3",
      actual: withoutMeta.error ?? `PUT ${withoutMeta.status}; GET percentage=${fmt(g.json?.percentage)}`,
      note: "metadata is off by default in KOReader and can be toggled per device, so 'absent' must never mean 'delete'",
    });
  }

  section("§5.5  Document id character set");

  // The reference server's router only binds :document against [A-Za-z0-9_]+
  // (gin/core/routes.lua:44). Anything else 404s at nginx, BEFORE the
  // controller runs -- while the PUT, which reads `document` from the JSON
  // body, happily stores it. That asymmetry is a data black hole, so the
  // round-trip is asserted as a MUST and the charset as INFO.
  for (const [label, docId] of [
    ["a hyphen", `kosyncprobe-hyphen`],
    ["a dot", `kosyncprobe.dot`],
    ["a colon", `kosyncprobe:colon`],
  ]) {
    const put = await call("PUT", "/syncs/progress", {
      body: { document: docId, progress: "1", percentage: 0.1, device: "conformance", device_id: "d" },
    });
    const get = await call("GET", `/syncs/progress/${docId}`);
    const stored = put.status === 200;
    const readable = get.status === 200 && get.json?.percentage !== undefined;
    assert({
      id: "K-DOC-ID-1", section: "§5.5", level: "SHOULD",
      title: `a document id containing ${label} is not silently write-only`,
      ok: !stored || readable,
      expected: "either the PUT is rejected, or the position can be read back",
      actual: put.error ?? get.error ?? `PUT ${put.status}, GET ${get.status}${readable ? " (readable)" : " (NOT readable)"}`,
      note: stored && !readable
        ? "the PUT stored a position that GET can never retrieve. THE REFERENCE SERVER ALSO FAILS THIS (gin/core/routes.lua:44 binds :document against [A-Za-z0-9_]+ only, so the read 404s at nginx while the write succeeds), which is why it is SHOULD and not MUST: it is a defect of the reference, recorded rather than required. Clients send 32-char hex, so it is invisible in normal use. Reject the id on PUT, or widen the read route."
        : undefined,
    });
    assert({
      id: "K-DOC-ID-2", section: "§5.5", level: "INFO",
      title: `how a document id containing ${label} is handled`,
      ok: true,
      actual: put.error ?? `PUT ${put.status}, GET ${get.status}`,
      note: !stored
        ? "rejected on write, which is the safe answer."
        : readable
          ? "accepted and readable; more permissive than the reference server."
          : "accepted on write, unreadable on read.",
    });
  }

  // ===================================================== isolation
  section("§12  Cross-user isolation");

  if (USER2 && KEY2) {
    const r = await call("GET", `/syncs/progress/${DOC}`, {
      auth: false,
      headers: { "x-auth-user": USER2, "x-auth-key": String(KEY2).toLowerCase() },
    });
    assert({
      id: "K-ISO-1", section: "§2", level: "MUST",
      title: "one user cannot read another user's position for the same document id",
      ok: r.status === 200 && isObject(r.json) && r.json.percentage === undefined,
      expected: "200 with no percentage — progress is keyed by (user, document)",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.json?.percentage !== undefined
        ? "the second account can read the first account's reading position. Document ids are derived from file contents, so any two users with the same book collide."
        : undefined,
    });
  } else {
    assert({
      id: "K-ISO-1", section: "§2", level: "MUST",
      title: "cross-user isolation",
      skip: true,
      note: "pass --second-user and --second-password (or --second-key) to check it",
    });
  }

  // ===================================================== identifiers
  section("§5.8  Optional identifier matching (PROPOSED — not merged upstream)");
  await identifierSuite();

  // ===================================================== optional endpoints
  section("§5.6/5.7  Optional server-only endpoints");

  {
    const r = await call("PUT", "/users/password", { body: { password: KEY } });
    assert({
      id: "K-PWD-1", section: "§5.7", level: "INFO",
      title: "PUT /users/password",
      ok: true,
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status === 200
        ? "implemented (set to the same key, so nothing changed)"
        : "not implemented; optional — no reference client calls it",
    });
  }
  // DELETE /users/me is NOT probed: a conformant server would delete the
  // account under test. Its behaviour is documented in §5.6 and left to a
  // dedicated, opt-in run.
  assert({
    id: "K-DEL-1", section: "§5.6", level: "INFO",
    title: "DELETE /users/me",
    ok: true,
    actual: "not probed",
    note: "probing it would delete the account under test. Optional endpoint; no reference client calls it.",
  });

  return finish();
}

// -------------------------------------------------- identifiers (proposed)

/**
 * SPEC.md §5.8 — optional matching of one reading position by several document
 * identifiers, as proposed in koreader/koreader-sync-server#55. THAT PULL
 * REQUEST IS NOT MERGED. Every requirement here is MAY: a server that does not
 * implement it skips the family, and one that does is held to all of it.
 */

const ID_SECTION = "§5.8";
const ID_XPOINTER = "/body/DocFragment[11]/body/div/p[7]/text().123";

// Fresh digests per run. An alias is created and never repointed, so a second
// run against reused ids would resolve through the first run's aliases and
// assert nothing. Every digest is 32 hex characters, which the reference
// server's read route can serve ([K-GET-1]).
const ID_RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
const dg = (tag) => md5(`${opts.document}:${ID_RUN}:${tag}`);

const idList = (pairs) => pairs.map(([type, value]) => ({ type, value }));
const idQuery = (pairs) => pairs.map(([type, value]) => `${type}:${value}`).join(",");

const idPut = (document, pairs, progress, percentage = 0.5) =>
  call("PUT", "/syncs/progress", {
    body: {
      document,
      ...(pairs === null ? {} : { identifiers: Array.isArray(pairs) ? idList(pairs) : pairs }),
      progress,
      percentage,
      device: "kosync-conformance",
      device_id: "conformance-device-1",
    },
  });

const idGet = (document, pairs) =>
  call("GET", `/syncs/progress/${document}${pairs === null ? "" : `?ids=${typeof pairs === "string" ? pairs : idQuery(pairs)}`}`);

feature({
  key: "identifiers",
  title: "multi-identifier document matching",
  section: ID_SECTION,
  requirements: "K-ID-",
  // A push naming identifiers answers with `match` on a server that implements
  // the proposal and with the pre-proposal body on one that does not. The
  // proposal adds no endpoint, so there is nothing else to look at.
  probe: async () => {
    const id = dg("probe");
    const r = await idPut(id, [["content", id], ["structure", dg("probe-s")]], ID_XPOINTER, 0.11);
    if (r.status === 200 && typeof r.json?.match === "string") return true;
    return {
      present: false,
      note: `a push naming identifiers answered ${r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`}, with no \`match\` field`,
    };
  },
});

// Titles, in one place, because the skip path emits the whole family at once.
const ID_ASSERTIONS = [
  ["K-ID-1", "a push naming no identifiers returns today's body, with no match field"],
  ["K-ID-1b", "a read naming no identifiers returns today's body and follows no alias"],
  ["K-ID-2", "a push naming identifiers returns {document, match, timestamp}"],
  ["K-ID-3", "match names the identifier type that resolved the lookup"],
  ["K-ID-3b", "a read naming its own identifiers matches on the first of them"],
  ["K-ID-4", "a renamed copy resolves through an identifier it shares, and gets the canonical digest"],
  ["K-ID-5", "the reader's order of preference decides which identifier matches"],
  ["K-ID-6", "progress_match differs from match when a weaker identifier let another copy write"],
  ["K-ID-6b", "progress_match is none when the reader shares nothing with the writer"],
  ["K-ID-6c", "a progress string written without identifiers is attributed to its own digest"],
  ["K-ID-7", "an alias never shadows a document that exists in its own right"],
  ["K-ID-12b", "a weak match does not register the identifiers ranked above it"],
  ["K-ID-16", "an entry marked weak is accepted, and a strong match still adopts"],
  ["K-ID-17", "a push resolving only through a weak entry does not adopt that record"],
  ["K-ID-17b", "the weak entry is still registered, so a later read is seeded through it"],
  ["K-ID-8", "an identifier list that does not name the document is rejected"],
  ["K-ID-8b", "the document need not be first, and the record is created under it"],
  ["K-ID-9", "more than 8 identifiers is rejected"],
  ["K-ID-9d", "exactly 8 identifiers is accepted"],
  ["K-ID-9b", "a malformed ids parameter is rejected"],
  ["K-ID-9c", "a duplicate identifier type is rejected"],
  ["K-ID-10", "one account's aliases do not resolve for another"],
  ["K-ID-11", "a document unknown under every identifier still returns 200 with an empty body"],
];

const ID_TITLE = Object.fromEntries(ID_ASSERTIONS);

async function identifierSuite() {
  const XP = ID_XPOINTER;
  const SEC = ID_SECTION;
  const put = idPut;
  const get = idGet;
  const query = idQuery;
  const rejected = (r) => r.status === 403 && r.json?.code === 2003;

  // The probe has already answered. A server that does not implement the
  // feature gets the family as SKIP rather than thirty pointless requests.
  if (!features.get("identifiers").present) {
    for (const [id, title] of ID_ASSERTIONS) {
      assert({ id, section: SEC, level: "MAY", feature: "identifiers", title });
    }
    return;
  }

  // --- [K-ID-1] a request that names none is answered exactly as before -----
  {
    const plain = dg("plain");
    const r = await put(plain, null, XP, 0.32);
    const keys = isObject(r.json) ? Object.keys(r.json).sort() : [];
    assert({
      id: "K-ID-1", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-1"],
      ok: r.status === 200 && keys.join(",") === "document,timestamp",
      expected: '200 with exactly {"document":…,"timestamp":…}',
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: isObject(r.json) && (r.json.match !== undefined || r.json.progress_match !== undefined)
        ? "the server volunteered a matching field to a request that asked for none; a client that did not opt in must see the response it has always seen"
        : undefined,
    });
  }

  {
    const doc = dg("bare");
    const alias = dg("bare-s");
    await put(doc, [["content", doc], ["structure", alias]], XP, 0.32);
    const r = await get(doc, null);
    const keys = isObject(r.json) ? Object.keys(r.json).sort().join(",") : "";
    const viaAlias = await get(alias, null);
    assert({
      id: "K-ID-1b", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-1b"],
      ok: r.status === 200
        && r.json?.match === undefined && r.json?.progress_match === undefined
        && r.json?.document === doc
        && viaAlias.status === 200 && isObject(viaAlias.json) && viaAlias.json.percentage === undefined,
      expected: "the pre-proposal body for the document itself, and {} for a digest that is only an alias",
      actual: r.error ?? viaAlias.error ?? `GET ${doc}: ${r.status} keys=[${keys}]; GET ${alias}: ${viaAlias.status} ${fmt(viaAlias.json ?? viaAlias.text)}`,
      note: viaAlias.json?.percentage !== undefined
        ? "a read that named no identifiers followed an alias. Aliases exist only for requests that opt in; following one silently changes what an existing client reads."
        : undefined,
    });
  }

  // --- the three-copy fixture ----------------------------------------------
  // original and repack share structure and metadata; edition shares only
  // metadata. The same shape the reference implementation's own spec uses.
  const c1 = dg("c1"), c2 = dg("c2"), c3 = dg("c3");
  const s1 = dg("s1"), s3 = dg("s3"), m = dg("m");
  const original = [["content", c1], ["structure", s1], ["metadata", m]];
  const repack = [["content", c2], ["structure", s1], ["metadata", m]];
  const edition = [["content", c3], ["structure", s3], ["metadata", m]];

  {
    const r = await put(c1, original, XP, 0.32);
    const keys = isObject(r.json) ? Object.keys(r.json).sort().join(",") : "";
    assert({
      id: "K-ID-2", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-2"],
      ok: r.status === 200 && keys === "document,match,timestamp"
        && r.json.document === c1 && typeof r.json.timestamp === "number",
      expected: `200 with exactly {"document":"${c1}","match":…,"timestamp":…}`,
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: keys.includes("progress_match")
        ? "progress_match belongs to a read; a write has no writer to compare against"
        : undefined,
    });
    assert({
      id: "K-ID-3", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-3"],
      ok: r.json?.match === "content",
      expected: '"content" — the first identifier, under which the record was created',
      actual: r.error ?? fmt(r.json?.match),
    });
  }

  {
    const r = await get(c1, original);
    assert({
      id: "K-ID-3b", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-3b"],
      ok: r.status === 200 && r.json?.document === c1
        && r.json?.match === "content" && r.json?.progress_match === "content"
        && r.json?.progress === XP,
      expected: `200 with document ${c1}, match "content", progress_match "content", progress round-tripped`,
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
    });
  }

  {
    const r = await get(c2, repack);
    assert({
      id: "K-ID-4", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-4"],
      ok: r.status === 200 && r.json?.document === c1 && r.json?.match === "structure"
        && r.json?.progress === XP,
      expected: `200 with document ${c1} (the canonical digest), match "structure", the position written for the other copy`,
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: isObject(r.json) && r.json.percentage === undefined
        ? "the renamed copy found nothing. Sharing a weaker identifier with a copy the account has already read is the whole point of the proposal."
        : r.json?.document === c2
          ? "the canonical digest was not echoed; a client cannot then address the record directly on its next read"
          : undefined,
    });
  }

  {
    // The same three identifiers, weakest first. A different one must win.
    const weakest = await get(m, [["metadata", m], ["structure", s1], ["content", c1]]);
    const strongest = await get(c1, original);
    assert({
      id: "K-ID-5", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-5"],
      ok: weakest.json?.match === "metadata" && strongest.json?.match === "content"
        && weakest.json?.document === c1,
      expected: 'match "metadata" when metadata is offered first, "content" when content is',
      actual: weakest.error ?? strongest.error
        ?? `metadata-first: ${fmt(weakest.json?.match)} (document ${fmt(weakest.json?.document)}); content-first: ${fmt(strongest.json?.match)}`,
      note: "the list is a preference order, not a set; a server that resolves in its own order gives two clients different answers for the same book",
    });
  }

  {
    // A third edition shares only metadata, and writes the position. The
    // reader still matches on its own content digest, so how the record was
    // found and who wrote the progress string are different answers.
    await put(c3, edition, "/body/DocFragment[3]/body/p[9]", 0.5);
    const r = await get(c1, original);
    assert({
      id: "K-ID-6", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-6"],
      ok: r.json?.match === "content" && r.json?.progress_match === "metadata",
      expected: 'match "content" (the record is the reader\'s own digest), progress_match "metadata" (all the writer shared)',
      actual: r.error ?? `match ${fmt(r.json?.match)}, progress_match ${fmt(r.json?.progress_match)}`,
      note: r.json?.progress_match === r.json?.match
        ? "progress_match tracked match. They answer different questions: a reader can match a record on its own content digest and still be reading a different edition from the one that wrote the position, in which case the xpointer does not apply."
        : undefined,
    });
  }

  {
    // d2 takes the position over through the structure digest, leaving a
    // writer whose identifiers the metadata-only reader shares nothing with.
    const d1 = dg("d1"), d2 = dg("d2"), ds = dg("ds"), dm = dg("dm");
    await put(d1, [["content", d1], ["structure", ds], ["metadata", dm]], XP, 0.2);
    await put(d2, [["content", d2], ["structure", ds]], "/body/p[4]", 0.3);
    const r = await get(dm, [["metadata", dm]]);
    assert({
      id: "K-ID-6b", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-6b"],
      ok: r.json?.document === d1 && r.json?.match === "metadata" && r.json?.progress_match === "none",
      expected: 'match "metadata", progress_match "none"',
      actual: r.error ?? `document ${fmt(r.json?.document)}, match ${fmt(r.json?.match)}, progress_match ${fmt(r.json?.progress_match)}`,
      note: "the reader has to be able to tell 'found your book, but a copy you know nothing about wrote this position' from 'this position is yours'",
    });
  }

  {
    const e1 = dg("e1"), es = dg("es");
    await put(e1, [["content", e1], ["structure", es]], XP, 0.2);
    await put(e1, null, "/body/p[7]", 0.4);
    const r = await get(e1, [["content", e1], ["structure", es]]);
    assert({
      id: "K-ID-6c", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-6c"],
      ok: r.json?.progress === "/body/p[7]" && r.json?.match === "content"
        && r.json?.progress_match === "content",
      expected: 'the later position, match "content", progress_match "content"',
      actual: r.error ?? `progress ${fmt(r.json?.progress)}, match ${fmt(r.json?.match)}, progress_match ${fmt(r.json?.progress_match)}`,
      note: "identifiers left on a record by an earlier client must stop being attributed once a client that named none overwrites the progress string, or the reader is told an xpointer is safe on the strength of a claim nobody made",
    });
  }

  {
    const f1 = dg("f1"), f2 = dg("f2"), fs = dg("fs");
    await put(f1, [["content", f1], ["structure", fs]], XP, 0.2);
    // f2 is known separately first, so it keeps its own record.
    await put(f2, [["content", f2]], "/body/p[2]", 0.1);
    await put(f2, [["content", f2], ["structure", fs]], "/body/p[3]", 0.5);
    const own = await get(f2, [["content", f2]]);
    const other = await get(f1, [["content", f1]]);
    assert({
      id: "K-ID-7", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-7"],
      ok: own.json?.document === f2 && own.json?.progress === "/body/p[3]"
        && other.json?.document === f1 && other.json?.progress === XP,
      expected: `${f2} keeps its own record at /body/p[3], and ${f1} is untouched`,
      actual: own.error ?? other.error
        ?? `own: document ${fmt(own.json?.document)} progress ${fmt(own.json?.progress)}; other: document ${fmt(other.json?.document)} progress ${fmt(other.json?.progress)}`,
      note: other.json?.progress !== XP
        ? "a weak identifier moved one book's position onto another book's record. An alias must lose a race against a digest that is a document in its own right, not win it."
        : undefined,
    });
  }

  {
    // Two unrelated books a library tagged alike: they share only the weakest
    // identifier the client offers.
    const shared = dg("shared");
    const b1 = dg("b1"), b1s = dg("b1s");
    const b2 = dg("b2"), b2s = dg("b2s");
    await put(b1, [["content", b1], ["structure", b1s], ["weak", shared]], XP, 0.8);
    const merged = await put(b2, [["content", b2], ["structure", b2s], ["weak", shared]], "/body/p[1]", 0.01);

    // The tagging is corrected, so nothing is shared any more. The second book
    // gets its own record back only if its content digest was never registered.
    const corrected = [["content", b2], ["structure", b2s], ["weak", dg("shared2")]];
    const after = await put(b2, corrected, "/body/p[4]", 0.05);
    const read = await get(b2, corrected);
    assert({
      id: "K-ID-12b", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-12b"],
      ok: merged.json?.match === "weak" && merged.json?.document === b1
        && after.status === 200 && after.json?.document === b2 && after.json?.match === "content"
        && read.json?.percentage === 0.05,
      expected: `the weak match resolves to ${b1}; once it no longer matches, ${b2} is its own record again`,
      actual: merged.error ?? after.error ?? read.error
        ?? `weak match: ${fmt(merged.json)}; after correcting: ${fmt(after.json)}; read: ${fmt(read.json?.percentage)}`,
      note: after.json?.document === b1
        ? "the caller's content digest was registered as an alias to a record found on its weakest identifier, so a wrong match is permanent: correcting what caused it does not free the copy. An alias created here is never repointed and nothing unlinks one."
        : undefined,
    });
  }

  {
    // A weak entry may resolve a read, but it must not let a write claim a
    // record that already exists.
    const k1 = dg("wk1"), k1s = dg("wk1s"), shared = dg("wkm");
    const k2 = dg("wk2"), k2s = dg("wk2s");
    const weak = (v) => ({ type: "metadata", value: v, weak: true });
    const listFor = (c, st) => [["content", c], ["structure", st]];

    const mk = (document, c, st, progress, pct) =>
      call("PUT", "/syncs/progress", {
        body: {
          document,
          identifiers: [...listFor(c, st).map(([type, value]) => ({ type, value })), weak(shared)],
          progress, percentage: pct, device: "kosync-conformance", device_id: "conformance-device-1",
        },
      });

    const first = await mk(k1, k1, k1s, XP, 0.8);
    assert({
      id: "K-ID-16", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-16"],
      ok: first.status === 200 && first.json?.document === k1 && first.json?.match === "content",
      expected: `200 creating ${k1}, match "content"`,
      actual: first.error ?? `${first.status} ${fmt(first.json ?? first.text)}`,
      note: rejected(first)
        ? "a `weak` flag on an identifier was rejected; it is an optional field on the entry, not a new type"
        : undefined,
    });

    const second = await mk(k2, k2, k2s, "/body/p[1]", 0.01);
    const original = await get(k1, listFor(k1, k1s));
    assert({
      id: "K-ID-17", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-17"],
      ok: second.status === 200 && second.json?.document === k2
        && original.json?.progress === XP && original.json?.percentage === 0.8,
      expected: `${k2} written under its own digest, and ${k1} left at ${XP}`,
      actual: second.error ?? original.error
        ?? `push answered ${fmt(second.json?.document)}; the first record now reads ${fmt(original.json?.progress)} at ${fmt(original.json?.percentage)}`,
      note: second.json?.document === k1
        ? "the second work adopted the first's record through an identifier the caller marked weak, and overwrote the position stored there. A weak identifier seeds a reader; it does not claim a record."
        : undefined,
    });

    // K-ID-17 on its own cannot tell "did not adopt" from "never registered the
    // weak value at all": a server that skipped weak aliases would create k2,
    // leave k1 alone, and pass it vacuously. Weakness governs adoption, not
    // registration, so a third copy sharing only the weak value must still be
    // seeded from the first record.
    const k3 = dg("wk3");
    const seeded = await get(k3, [["content", k3], ["metadata", shared]]);
    assert({
      id: "K-ID-17b", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-17b"],
      ok: seeded.status === 200 && seeded.json?.document === k1
        && seeded.json?.progress === XP && seeded.json?.progress_match === "metadata",
      expected: `200 resolving to ${k1} through the weak value, progress_match "metadata"`,
      actual: seeded.error ?? `${seeded.status} ${fmt(seeded.json ?? seeded.text)}`,
      note: isObject(seeded.json) && seeded.json.percentage === undefined
        ? "the weak identifier resolved nothing, so it was never registered as an alias. Weakness governs whether a write claims a record, not whether the value is indexed — without the alias there is nothing to seed a later copy from, which is the whole reason the type exists."
        : undefined,
    });
  }

  // --- validation -----------------------------------------------------------
  {
    const g1 = dg("g1"), gs = dg("gs");
    const write = await put(g1, [["structure", gs], ["metadata", dg("gm")]], XP, 0.2);
    const read = await get(g1, [["structure", gs]]);
    assert({
      id: "K-ID-8", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-8"],
      ok: rejected(write) && rejected(read),
      expected: "403 with {code:2003} on both the push and the read",
      actual: write.error ?? read.error
        ?? `PUT ${write.status} ${fmt(write.json)}, GET ${read.status} ${fmt(read.json)}`,
      note: write.status === 200
        ? "a list that names the document nowhere leaves the record unreachable by a client that sends no identifiers, which is every client today"
        : undefined,
    });
  }

  {
    // The shape a filename-matching KOReader sends: the digest it is addressed
    // by is the weakest thing it knows.
    const w1 = dg("w1"), wc = dg("wc"), ws = dg("ws");
    const write = await put(w1, [["content", wc], ["structure", ws], ["filename", w1]], XP, 0.2);
    const plain = await get(w1, null);
    const matched = await get(w1, [["content", wc], ["structure", ws], ["filename", w1]]);
    assert({
      id: "K-ID-8b", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-8b"],
      ok: write.status === 200 && write.json?.document === w1 && write.json?.match === "filename"
        && plain.status === 200 && plain.json?.percentage !== undefined
        && matched.json?.match === "content",
      expected: `200 creating ${w1}, match "filename"; a read naming none finds it; a read naming all matches on "content"`,
      actual: write.error ?? plain.error ?? matched.error
        ?? `PUT ${write.status} ${fmt(write.json)}; plain GET ${plain.status} ${fmt(plain.json)}; matched GET match=${fmt(matched.json?.match)}`,
      note: rejected(write)
        ? "the document was rejected for not being first. Position is preference, not identity: a client whose document digest is its weakest identifier has to be able to rank the others above it."
        : plain.json?.percentage === undefined
          ? "the record was not created under `document`, so a client that names no identifiers cannot reach it"
          : undefined,
    });
  }

  {
    const h1 = dg("h1");
    const many = [["content", h1]];
    for (let i = 1; i <= 8; i++) many.push([`t${i}`, dg(`h-${i}`)]);
    const write = await put(h1, many, XP, 0.2);
    const read = await get(h1, many);
    assert({
      id: "K-ID-9", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-9"],
      ok: rejected(write) && rejected(read),
      expected: "403 with {code:2003} for a list of 9",
      actual: write.error ?? read.error
        ?? `PUT ${write.status} ${fmt(write.json)}, GET ${read.status} ${fmt(read.json)}`,
      note: "each identifier is a redis lookup on the read path and an alias write on the write path; the cap is what keeps one request's cost bounded",
    });
    const eight = many.slice(0, 8);
    const ok8 = await put(h1, eight, XP, 0.2);
    assert({
      id: "K-ID-9d", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-9d"],
      ok: ok8.status === 200,
      expected: "200 — the cap is 8, inclusive",
      actual: ok8.error ?? `${ok8.status} ${fmt(ok8.json ?? ok8.text)}`,
    });
  }

  {
    const j1 = dg("j1");
    const read = await get(j1, j1);                       // no type, no colon
    const empty = await get(j1, "");                      // ids present, empty
    assert({
      id: "K-ID-9b", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-9b"],
      ok: rejected(read) && (rejected(empty) || empty.status === 403),
      expected: "403 with {code:2003}",
      actual: read.error ?? `bare value: ${read.status} ${fmt(read.json)}; empty: ${empty.status} ${fmt(empty.json)}`,
      note: "an unparseable list must not degrade into 'no identifiers named', which would silently answer a matching request with an unmatched body",
    });
  }

  {
    const k1 = dg("k1");
    const write = await put(k1, [["content", k1], ["content", dg("k2")]], XP, 0.2);
    const read = await get(k1, [["content", k1], ["content", dg("k2")]]);
    assert({
      id: "K-ID-9c", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-9c"],
      ok: rejected(write) && rejected(read),
      expected: "403 with {code:2003}",
      actual: write.error ?? read.error
        ?? `PUT ${write.status} ${fmt(write.json)}, GET ${read.status} ${fmt(read.json)}`,
      note: "two values for one type is a client bug; resolving it in list order would make the answer depend on which the client happened to put first",
    });
  }

  // --- isolation ------------------------------------------------------------
  if (USER2 && KEY2) {
    const r = await call("GET", `/syncs/progress/${c2}?ids=${query(repack)}`, {
      auth: false,
      headers: { "x-auth-user": USER2, "x-auth-key": String(KEY2).toLowerCase() },
    });
    assert({
      id: "K-ID-10", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-10"],
      ok: r.status === 200 && isObject(r.json) && r.json.percentage === undefined,
      expected: "200 with no percentage — an alias is a per-account record, like the position it points at",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.json?.percentage !== undefined
        ? "the second account resolved the first account's alias. Identifiers are derived from file contents, so every account that owns the same book collides."
        : undefined,
    });
  } else {
    assert({
      id: "K-ID-10", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-10"],
      skip: true,
      note: "pass --second-user and --second-password (or --second-key) to check it",
    });
  }

  {
    const unseen = dg(`unseen-${Date.now()}`);
    const r = await get(unseen, [["content", unseen], ["structure", dg("unseen-s")]]);
    assert({
      id: "K-ID-11", section: SEC, level: "MAY", feature: "identifiers",
      title: ID_TITLE["K-ID-11"],
      ok: r.status === 200 && isObject(r.json) && r.json.percentage === undefined
        && r.json.match === undefined && r.json.progress_match === undefined,
      expected: "200 with {} — no percentage, and no matching fields to report",
      actual: r.error ?? `${r.status} ${fmt(r.json ?? r.text)}`,
      note: r.status !== 200
        ? "naming identifiers must not change [K-GET-3]: an unread book is still 200 with an empty body, not 404"
        : undefined,
    });
  }
}

// ------------------------------------------------------------------- report

function finish() {
  const counts = { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 };
  for (const r of results) counts[r.status]++;
  const failuresAt = (level) => results.filter((r) => r.status === "FAIL" && r.level === level);
  const mustFailures = failuresAt("MUST");
  const shouldFailures = failuresAt("SHOULD");
  const mayFailures = failuresAt("MAY");

  // MAY is named only when the run actually held the server to an optional
  // feature, so a reported 0 means "implemented and correct" rather than
  // "never looked".
  const breakdown = [`${mustFailures.length} MUST`, `${shouldFailures.length} SHOULD`];
  if (results.some((r) => r.level === "MAY")) breakdown.push(`${mayFailures.length} MAY`);

  process.stdout.write(`\n${"=".repeat(72)}\n`);
  process.stdout.write(
    `${counts.PASS} passed, ${counts.FAIL} failed (${breakdown.join(", ")}), ` +
      `${counts.SKIP} skipped, ${counts.INFO} informational\n`,
  );

  if (counts.FAIL > 0) {
    process.stdout.write(`\nFailures, most severe first:\n`);
    for (const r of [...mustFailures, ...shouldFailures, ...mayFailures]) {
      process.stdout.write(`  ${r.level.padEnd(6)} [${r.id}] ${r.title}\n`);
      process.stdout.write(`         expected ${fmt(r.expected)}\n`);
      process.stdout.write(`         got      ${fmt(r.actual)}\n`);
      process.stdout.write(`         ${SPEC} ${r.section}\n`);
    }
  }

  if (networkFailures > 0) {
    process.stdout.write(`\n${networkFailures} request(s) failed at the transport level; those assertions cannot be trusted.\n`);
  }

  const report = {
    spec: SPEC,
    specVersion: 1,
    target: BASE,
    user: USER,
    ranAt: new Date().toISOString(),
    profile: {
      register: !!opts.register,
      noRegister: !!opts.noRegister,
      registrationOff: !!opts.registrationOff,
      noHealthcheck: !!opts.noHealthcheck,
      strictAccept: !!opts.strictAccept,
      isolationChecked: !!(USER2 && KEY2),
    },
    features: Object.fromEntries(
      [...features.values()].map((f) => [f.key, { present: !!f.present, section: f.section, note: f.note ?? null }]),
    ),
    summary: {
      ...counts,
      mustFailures: mustFailures.length,
      shouldFailures: shouldFailures.length,
      mayFailures: mayFailures.length,
      networkFailures,
    },
    // An optional feature is optional: MUST alone decides conformance.
    conformant: mustFailures.length === 0 && networkFailures === 0,
    assertions: results,
  };

  if (opts.json) {
    writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nJSON report written to ${opts.json}\n`);
  }

  process.stdout.write(
    report.conformant
      ? `\nRESULT: conformant (every MUST satisfied)\n`
      : `\nRESULT: NOT conformant (${mustFailures.length} MUST failure(s))\n`,
  );
  process.exit(report.conformant ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\nfatal: ${error?.stack ?? error}\n`);
  process.exit(2);
});

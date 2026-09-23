# The kosync protocol

A description of the HTTP progress-synchronisation protocol spoken by
KOReader's `kosync` plugin and the KOReader sync server.

| | |
|---|---|
| **Version of this document** | 1 |
| **Date** | 2026-09-21 |
| **Status** | Descriptive. Not endorsed by the KOReader project. |
| **Protocol version described** | `v1` (the only version that exists) |

---

## 1. Scope and status

### 1.1 What this document is

kosync has no written specification. The normative definition of the protocol
is the source of two programs:

| Role | Repository | Commit pinned for every citation below |
|---|---|---|
| Reference **client** | `koreader/koreader` | `dcf6e3b426ffca0de52e543c725a8000ea64f105` (2026-09-20) |
| Reference **server** | `koreader/koreader-sync-server` | `237ab22943a206e74451176d709855c2b429eccf` (2026-09-10) |
| Server's web framework | `ostinelli/gin` | `cb35e87fa0671fcf25e5bce5cb9487dee8b497e2` (2015-09-14) |
| Client test fixtures | `koreader/test-data` | `c3b5d06e1ae8ea088bd898b0e7f9da3753d0d86c` (2024-12-16) |

This document describes the behaviour of those two programs. It is a
**description of observed behaviour, not a normative standard blessed by the
KOReader project.** Where this document and the reference implementations
disagree, the implementations are right and this document has a bug.

**§5.8 is the one exception, and it says so at its head.** It describes an
open, unmerged pull request rather than released behaviour, it is pinned to a
branch commit rather than to the table above, and nothing in it is part of
conformance. Every other section describes code that ships.

The reference server was **built and run** for this document:
`docker.io/koreader/kosync:latest` (image `db2a16684d0b`, OpenResty 1.29.2.3,
`X-Framework: gin/0.2.0`), under Podman on arm64, on 2026-09-21. Claims marked
**[measured]** against "the reference server" were checked against that
instance. `reference-server/` in this repository has the recipe.

Every factual claim below is one of:

- a **citation** of the form `repo path:line`, pinned to the commits above; or
- marked **[measured]**, meaning it was produced by running code on 2026-09-21
  and the exact command is given in §13; or
- marked **[unverified]**, meaning it could not be checked and why.

### 1.2 What this document is not

- It does not describe the KOReader *client's* user interface, scheduling,
  debouncing or retry queue except where those are visible on the wire.
- It does not cover the non-protocol endpoints that individual servers add.
- It does not define a v2. There is no v2.

### 1.3 Conformance language

`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT` and `MAY` are used in the RFC 2119
sense, but note §1.1: the authority is the reference implementation, not this
document's use of capital letters.

A `MAY` requirement belongs to an **optional feature**. A server is free not to
implement one, and is held to all of it if it does: optional to offer is not
optional to get right. §12.5 describes how the verifier tells the two apart.

Normative statements carry a bracketed identifier, for example **[K-AUTH-2]**.
The conformance verifier in §12 cites those identifiers, so every requirement
here is either mechanically checked or explicitly listed as untestable in
§12.4.

---

## 2. Model

**[K-ISO-1]** Positions are namespaced per account. A `document` stored for one
user MUST NOT be visible to another, whatever the id. This matters more than it
looks: document ids are derived from file contents (§8), so any two users of
the same server who own the same book derive the *same* id. On the reference
server the account name is part of the Redis key
(`syncs_controller.lua:5`: `doc_key = "user:%s:document:%s"`), so isolation is
structural.

A kosync server stores, per `(user, document)` pair, **one** reading position:

```
(user, document) -> { percentage, progress, device, device_id, timestamp }
```

There is no history, no per-device fan-out and no conflict detection on the
server. The server is a last-write-wins key/value store. All conflict
resolution happens on the client (§9).

`document` is an opaque string chosen by the client. The server never
interprets it and never sees the file it identifies
(`koreader-sync-server README.md:100-103`). §8 describes how KOReader derives
it, which matters only because two devices must derive the *same* string for
the same book.

---

## 3. Transport and framing

### 3.1 Base URL

**[K-URL-1]** Endpoint paths are appended to a base URL with no path prefix and
no version segment. The protocol version is carried in the `Accept` header
(§3.3), not the path.

The reference client's default base URL is
`https://sync.koreader.rocks:443/` (`koreader plugins/kosync.koplugin/api.json:2`).
A user-supplied `custom_server` replaces it wholesale
(`koreader plugins/kosync.koplugin/KOSyncClient.lua:25-27`).

> **[measured]** `https://sync.koreader.rocks/healthcheck` did not respond
> within 8 seconds on 2026-09-21 (`curl` exit 28, HTTP code `000`). No claim
> in this document has been checked against the official hosted server.

**[K-URL-2]** A server MUST serve the protocol over TLS. Credentials are sent
on every request in plaintext headers and the password hash is an unsalted MD5
(§4), so the transport is the only confidentiality the scheme has. The
reference server terminates TLS itself on port 7200 with a self-signed
certificate, and offers plaintext on port 17200 for use behind a reverse proxy
(`koreader-sync-server config/nginx.conf:29-46`, `README.md:56-65`).

### 3.2 HTTP methods and paths

| Method | Path | §  | Auth | Defined in |
|---|---|---|---|---|
| `GET` | `/healthcheck` | 5.1 | none | server only |
| `POST` | `/users/create` | 5.2 | none | client + server |
| `GET` | `/users/auth` | 5.3 | required | client + server |
| `PUT` | `/syncs/progress` | 5.4 | required | client + server |
| `GET` | `/syncs/progress/:document` | 5.5 | required | client + server |
| `DELETE` | `/users/me` | 5.6 | required | server only |
| `PUT` | `/users/password` | 5.7 | required | server only |

Routes: `koreader-sync-server config/routes.lua:9-18`. Client method
definitions: `koreader plugins/kosync.koplugin/api.json:5-53`.

"server only" means the reference client never calls it; it exists for other
tooling and is documented in the server's README.

**[K-URL-3]** A request to a path or method not in this table MUST NOT be
routed. The reference server returns a bare nginx `404` with an HTML body, not
a JSON error (`gin gin/core/router.lua:76-79`, `ngx.exit(ngx.HTTP_NOT_FOUND)`).

### 3.3 The `Accept` header

**[K-ACC-1]** A client MUST send:

```
Accept: application/vnd.koreader.v1+json
```

The reference client sets it on every request via a Spore middleware
(`koreader plugins/kosync.koplugin/KOSyncClient.lua:28-31`):

```lua
package.loaded["Spore.Middleware.GinClient"] = {}
require("Spore.Middleware.GinClient").call = function(_, req)
    req.headers["accept"] = "application/vnd.koreader.v1+json"
end
```

**[K-ACC-2]** The reference server **requires** it and uses it to select the
API version. `gin` matches the header against a Lua pattern built from the
application name (`gin gin/core/router.lua:35`):

```lua
local accept_header_matcher = "^application/vnd." .. Application.name .. ".v(%d+)(.*)+json$"
```

with `Application.name = "koreader"`
(`koreader-sync-server config/application.lua:2`). Failure modes
(`gin gin/core/router.lua:88-94`, codes from `gin gin/core/error.lua:18-20`):

| Condition | Status | `code` | `message` |
|---|---|---|---|
| `Accept` absent | 412 | 100 | `Accept header not set.` |
| `Accept` present but does not match the pattern | 412 | 101 | `Invalid Accept header format.` |
| Matches, but no routes for that major version | 412 | 102 | `Unsupported version specified in the Accept header.` |

**Code 100 is effectively unreachable in the field** [measured]. Omitting the
header at the application level does not omit it on the wire: `curl` sends
`Accept: */*` and Node's `fetch` sends `*/*` unless told otherwise. The
reference server therefore sees a header that does not match its pattern and
answers **101**, not 100. Reaching 100 requires a client that suppresses the
header outright. Verified against `koreader/kosync:latest` on 2026-09-21:

```
$ curl -s -D- http://127.0.0.1:8080/users/auth      # no -H Accept
HTTP/1.1 412 Precondition Failed
Content-Type: application/json
X-Framework: gin/0.2.0

{"message":"Invalid Accept header format.","code":101}
```

**[K-ACC-3]** A server MAY relax this and serve requests without the header.
Doing so is strictly more permissive and cannot break a conformant client. No
third-party implementation surveyed in §11 enforces it.

Because the pattern's `.` characters are unescaped Lua pattern metacharacters,
the reference server also accepts `application/vndXkoreaderXv1+json` and
similar. This is an artefact, not a feature; do not rely on it.

### 3.4 Request `Content-Type`

**[K-CT-1]** A client sending a body MUST send valid JSON. The reference
client's `Format.JSON` Spore middleware sets
`Content-Type: application/json` (`KOSyncClient.lua:67`, `:87`, `:117`, `:155`
each `enable("Format.JSON")`).

**[K-CT-2]** A server MUST NOT require the vendor media type on *requests*, and
SHOULD NOT reject a request on `Content-Type` grounds. The reference server
does no `Content-Type` inspection at all: it reads the raw body and JSON-decodes
it unconditionally (`gin gin/core/request.lua:17-29`).

This is the single most common interoperability break in the wild. See §11:
one surveyed server gates on `Content-Type: application/json` exactly, which
caused sync failures against a client that sent no `Content-Type`.

### 3.5 Request body parsing

**[K-BODY-1]** A body, when present, MUST be a JSON **object**. The reference
server rejects a JSON array with 400 code 104 and unparseable JSON with 400
code 103 (`gin gin/core/request.lua:25-28`, `gin gin/core/error.lua:21-22`):

```lua
ok, json_or_error = pcall(function() return jdecode(body_raw) end)
if ok == false then error({ code = 103 }) end
if json_or_error[1] ~= nil then error({ code = 104 }) end
```

**Undefined:** a JSON body that decodes to a scalar (`5`, `"x"`, `true`) makes
the reference server index a non-table. The resulting Lua error escapes the
`code`-carrying path and the response is implementation-defined. Do not send
one; do not rely on any particular answer.

### 3.6 Response media type

**[K-CT-3]** A server MUST return a JSON body with a JSON media type. The
reference server returns **`application/json`** — *not* the vendor type — on
every response, set unconditionally before routing
(`gin gin/core/router.lua:53`):

```lua
ngx.header.content_type = 'application/json'
```

**[K-CT-4]** A client MUST NOT dispatch on the response `Content-Type`. The
reference client does not inspect it; Spore's `Format.JSON` middleware decodes
the body regardless.

A server MAY return `application/vnd.koreader.v1+json` instead. Both are
observed in the wild (§11) and neither breaks the reference client.

The reference server also sets `X-Framework: gin/<version>`
(`gin gin/core/router.lua:32`, `:54`) and an explicit `Content-Length`
(`gin gin/core/router.lua:163`).

---

## 4. Authentication

**[K-AUTH-1]** Every authenticated request carries two headers:

```
x-auth-user: <username>
x-auth-key:  <credential>
```

Set by the reference client in
`koreader plugins/kosync.koplugin/KOSyncClient.lua:32-36`:

```lua
require("Spore.Middleware.KOSyncAuth").call = function(args, req)
    req.headers["x-auth-user"] = args.username
    req.headers["x-auth-key"] = args.userkey
end
```

**[K-AUTH-2]** `x-auth-key` is the **lowercase hexadecimal MD5 of the
password**, computed on the client. The plaintext password never leaves the
device. `koreader plugins/kosync.koplugin/main.lua:568` (register) and `:606`
(login):

```lua
local userkey = md5(password)
```

`md5` is `require("ffi/sha2").md5` (`main.lua:16`), which returns lowercase
hex.

**[K-AUTH-3]** A server MUST treat `x-auth-key` as an **opaque credential
string**. The reference server stores exactly the bytes it received at
registration and compares them for equality
(`koreader-sync-server app/controllers/1/syncs_controller.lua:93-103`):

```lua
function SyncsController:authorize()
    local redis = self:getRedis()
    local auth_user = self.request.headers['x-auth-user']
    local auth_key = self.request.headers['x-auth-key']
    if is_valid_field(auth_key) and is_valid_key_field(auth_user) then
        local key, err = redis:get(string.format(self.user_key, auth_user))
        if auth_key == key then
            return auth_user
        end
    end
end
```

Consequences a reimplementer must accept:

- The server never learns the plaintext password and cannot apply a password
  policy.
- The comparison is byte-exact, so **hex case matters**. A client that switches
  from lowercase to uppercase hex locks itself out.
- A server that re-hashes the received key (with bcrypt, Argon2, PBKDF2…) is
  hashing the MD5, not the password. That is a legitimate hardening choice —
  three of the seven implementations in §11 do it — but it means the server
  cannot import a database from the reference server, and the protocol is
  unchanged on the wire either way.

**[K-AUTH-4]** A username MUST NOT contain a colon (`:`) and MUST NOT be empty.
The reference server derives Redis keys by string interpolation, so a colon
would allow key injection
(`koreader-sync-server app/controllers/1/syncs_controller.lua:74-82`):

```lua
local function is_valid_field(field)
    return type(field) == "string" and string.len(field) > 0
end

local function is_valid_key_field(field)
    return is_valid_field(field) and not string.find(field, ":")
end
```

No other character is restricted. In particular `*` is permitted, and the
reference server's account-deletion script matches key prefixes with
`string.sub` rather than a glob precisely so that a username containing `*`
cannot delete another account's data
(`syncs_controller.lua:36-43`; regression test at
`spec/controllers/1/syncs_controller_spec.lua:179-182`).

**[K-AUTH-5]** `x-auth-key` MUST be non-empty. It is *not* required to be
32 hex characters: `is_valid_field` checks only non-emptiness. A server that
enforces `^[0-9a-f]{32}$` is stricter than the reference (§11).

**[K-AUTH-6]** Missing or wrong credentials on an authenticated endpoint MUST
produce HTTP **401** with error code **2001** (§6).

---

## 5. Endpoints

In the examples below, `→` marks a response. Bodies are shown verbatim.

### 5.1 `GET /healthcheck`

Unauthenticated liveness probe. Not called by the reference client; present so
operators can probe the server (`koreader-sync-server README.md:49-54`).

**[K-HC-1]** Returns 200 with `{"state":"OK"}`
(`koreader-sync-server app/controllers/1/syncs_controller.lua:276-278`):

```lua
function SyncsController:healthcheck()
    return 200, { state = 'OK' }
end
```

**[measured]** against the reference server (`koreader/kosync:latest`) on 2026-09-21:

```
$ curl -s -D- -H 'Accept: application/vnd.koreader.v1+json' \
       http://127.0.0.1:8080/healthcheck
HTTP/1.1 200 OK
Server: openresty/1.29.2.3
Content-Type: application/json
X-Framework: gin/0.2.0
Content-Length: 14

{"state":"OK"}
```

Note `Content-Type: application/json`, not the vendor type (§3.6). The `Accept`
header is still required on this route — it is dispatched like everything
else.

### 5.2 `POST /users/create`

Self-registration.

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `username` | string | yes | no colon, non-empty (**[K-AUTH-4]**) |
| `password` | string | yes | **already MD5'd by the client** |

**[K-REG-1]** The `password` field carries the *same value* as `x-auth-key`,
i.e. `md5(plaintext)`. The field name is a misnomer inherited from the client's
Spore descriptor (`koreader plugins/kosync.koplugin/api.json:5-17`); the client
passes `userkey`, not the password
(`koreader plugins/kosync.koplugin/main.lua:568-569`):

```lua
local userkey = md5(password)
local ok, status, body = pcall(client.register, client, username, userkey)
```

A server that hashes `password` again on the assumption that it is plaintext
will produce accounts that cannot authenticate.

**[K-REG-2]** Success returns **201** with `{"username":"<username>"}`
(`syncs_controller.lua:128`). The client treats *only* 201 as success
(`KOSyncClient.lua:78`: `return res.status == 201, res.body`).

**[K-REG-3]** A username that already exists returns **402** with code
**2002**, message `Username is already registered.`
(`syncs_controller.lua:121-125`, `config/errors.lua:19`). Registration is
implemented with Redis `SETNX`, so it is atomic.

**[K-REG-4]** An empty username, a username containing a colon, or an empty
password returns **403** with code **2003**, message `Invalid request`
(`syncs_controller.lua:116-119`, `config/errors.lua:20`).

**[K-REG-5]** When registration is disabled the route is bound to a different
action that returns **402** with code **2005**, message
`User registration is disabled.`
(`config/routes.lua:7-12`, `syncs_controller.lua:131-133`,
`config/errors.lua:22`):

```lua
local enable_user_registration = os.getenv("ENABLE_USER_REGISTRATION")
if enable_user_registration == "true" or enable_user_registration == "1" then
    v1:POST("/users/create", { controller = "syncs", action = "create_user" })
else
    v1:POST("/users/create", { controller = "syncs", action = "create_user_disabled" })
end
```

**402 is deliberate and it is overloaded.** `api.json` declares
`"expected_status": [201, 402]` for `register`
(`koreader plugins/kosync.koplugin/api.json:16`), so 402 is the *only*
non-success status the client's Spore descriptor expects. Both "username
taken" and "registration disabled" are 402; they are distinguished only by the
`code` field. A client that shows `body.message` — which the reference client
does (`main.lua:592-594`) — displays the right text either way.

**Divergence warning.** Every third-party server surveyed in §11 returns
something other than 402/2005 for registration-disabled: 403, or a
non-protocol status. A client that special-cases 402 will misreport them.

### 5.3 `GET /users/auth`

Credential check. No body.

**[K-AUTH-7]** Valid credentials return **200** with `{"authorized":"OK"}`
(`syncs_controller.lua:105-111`). Invalid credentials return **401** code
**2001**. `api.json` declares `"expected_status": [200, 401]`
(`api.json:21`).

**[measured]** against the reference server (`koreader/kosync:latest`) on 2026-09-21:

```
$ curl -s -D- -H 'Accept: application/vnd.koreader.v1+json' \
    -H 'x-auth-user: refuser1' -H 'x-auth-key: <md5(password)>' \
    http://127.0.0.1:8080/users/auth
HTTP/1.1 200 OK
Content-Type: application/json
X-Framework: gin/0.2.0

{"authorized":"OK"}

$ # the same request with a wrong key
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"message":"Unauthorized","code":2001}
```

### 5.4 `PUT /syncs/progress`

Push a reading position.

**Request body**

| Field | Type | Required by reference server | Notes |
|---|---|---|---|
| `document` | string | **yes** | opaque id, no colon, non-empty |
| `progress` | string | **yes** | see §7.2 — a string even when numeric |
| `percentage` | number | **yes** | 0–1 float, see §7.3 |
| `device` | string | **yes** | human-readable device name |
| `device_id` | string | no | opaque per-device id |
| `metadata` | object | no | see §7.6 |

An unmerged proposal adds one more optional field, `identifiers`; it is
described in §5.8 and is not part of conformance.

`api.json` lists `document`, `progress`, `percentage`, `device` and `device_id`
as `required_params` and `metadata` as an `optional_param`
(`koreader plugins/kosync.koplugin/api.json:23-44`) — but `required_params` is
a client-side Spore contract, not a server rule. The **server** requires
`document`, `percentage`, `progress` and `device`, and treats `device_id` as
optional (`syncs_controller.lua:242-259`):

```lua
local percentage = tonumber(self.request.body.percentage)
local progress = self.request.body.progress
local device = self.request.body.device
local device_id = self.request.body.device_id
local timestamp = os.time()
if percentage and progress and device then
    ...
    if device_id ~= nil then
        table.insert(fields, self.device_id_field)
        table.insert(fields, device_id)
    end
```

**[K-PUT-1]** A missing, empty or colon-containing `document` returns **403**
code **2004**, message `Field 'document' not provided.`
(`syncs_controller.lua:237-240`, `config/errors.lua:21`).

**[K-PUT-2]** A missing or non-numeric `percentage`, or a missing `progress` or
`device`, returns **403** code **2003** (`syncs_controller.lua:271-272`).
`percentage: 0` is accepted: `tonumber(0)` is `0`, which is truthy in Lua.

**[K-PUT-3]** Success returns **200** with exactly two fields
(`syncs_controller.lua:267-270`):

```json
{"document": "<document>", "timestamp": 1790005119}
```

**[K-PUT-4]** `timestamp` is **generated by the server** as Unix epoch
**seconds** (`syncs_controller.lua:246`: `local timestamp = os.time()`). Any
client-supplied `timestamp` in the body is ignored — the reference client never
sends one.

**[K-PUT-5]** The write is last-write-wins. The reference server `HSET`s the
whole field list, so a later PUT replaces percentage, progress, device and
timestamp unconditionally; there is no comparison against what is stored
(`syncs_controller.lua:56-62`, `:260-266`). The server's own test asserts this
(`spec/controllers/1/syncs_controller_spec.lua`, *"should get the latest
document progress"*: a second update with a **lower** percentage wins).

**[K-PUT-6]** The write is re-authorised **atomically with the write itself**,
inside a Redis Lua script, so a request that authorised before an account was
deleted cannot resurrect it (`syncs_controller.lua:54-62`):

```lua
local update_progress_script = [[
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call("HSET", KEYS[2], unpack(ARGV, 2))
return 1
]]
```

A failure of that check returns 401 code 2001, not 404.

**[measured]** against the reference server (`koreader/kosync:latest`) on 2026-09-21:

```
$ curl -s -D- -X PUT http://127.0.0.1:8080/syncs/progress \
    -H 'Accept: application/vnd.koreader.v1+json' \
    -H 'x-auth-user: refuser1' -H 'x-auth-key: <md5(password)>' \
    -H 'Content-Type: application/json' \
    -d '{"document":"59d481d168cca6267322f150c5f6a2a3",
         "progress":"/body/DocFragment[11]/body/div/p[7]/text().123",
         "percentage":0.4213,"device":"Kobo_clara","device_id":"1A2B3C4D5E6F",
         "metadata":{"filename":"leaves.epub","title":"Leaves of Grass",
                     "authors":"Walt Whitman"}}'
HTTP/1.1 200 OK
Content-Type: application/json
X-Framework: gin/0.2.0
Content-Length: 70

{"document":"59d481d168cca6267322f150c5f6a2a3","timestamp":1790006348}
```

The `metadata` object was accepted and silently discarded; it does not appear
in the read-back below (`[K-FLD-10]`).

**`202` never happens.** `api.json` declares
`"expected_status": [200, 202, 401]` for `update_progress`
(`koreader plugins/kosync.koplugin/api.json:44`), but the reference server has
no code path that returns 202, and the client treats only 200 as success
(`KOSyncClient.lua:137`: `callback(res.status == 200, res.status, res.body)`).
Do not emit 202; a client will read it as a failure and queue the update for
retry.

### 5.5 `GET /syncs/progress/:document`

Pull the stored position for one document.

**[K-GET-1]** `:document` is a single path segment, and on the reference server
it MUST match **`[A-Za-z0-9_]+`**. This is much tighter than the controller's
own colon check, and it bites first: the constraint is baked into the router's
pattern compiler (`gin gin/core/routes.lua:40-47`):

```lua
function Version:build_named_parameters(pattern)
    local params = {}
    local new_pattern = sgsub(pattern, "/:([A-Za-z0-9_]+)", function(m)
        tappend(params, m)
        return "/([A-Za-z0-9_]+)"
    end)
    return new_pattern, params
end
```

A document id containing anything else — a hyphen, a dot, a colon — **matches
no route at all**, so the request never reaches `syncs_controller` and the
answer is a bare nginx `404` with an **HTML** body, not a JSON error and not
403/2004. A document id containing `/` cannot be expressed at all, since it
would change the path.

**[K-DOC-ID-1] A server MUST NOT accept on `PUT` a document id it cannot serve
on `GET`.** Either reject the write or widen the read. **[K-DOC-ID-2]** records
which character set a given server actually accepts, for the divergence table;
it is an observation, not a requirement.

The reference server violates `[K-DOC-ID-1]`. `PUT` and `GET` do not agree on
what a legal document id is, so it will silently store positions it can never
return.
`PUT` takes `document` from the JSON body, where no router pattern applies, so
it accepts any non-empty colon-free string and writes it to Redis. `GET` routes
on the path, so it can only retrieve ids matching `[A-Za-z0-9_]+`.

**[measured]** against the reference server (`koreader/kosync:latest`,
OpenResty 1.29.2.3, `gin/0.2.0`) on 2026-09-21:

| `document` | `PUT /syncs/progress` | `GET /syncs/progress/:document` |
|---|---|---|
| `abc123DEF_456` | 200 | **200**, full body |
| `59d481d168cca6267322f150c5f6a2a3` | 200 | **200**, full body |
| `has-a-hyphen` | **200** | **404**, `text/html` |
| `has.a.dot` | **200** | **404**, `text/html` |

This is a defect in the reference implementation, recorded here rather than
required of anyone: see §14.4. It is invisible in normal use because every
KOReader client sends a 32-character lowercase hex digest, which satisfies
`[A-Za-z0-9_]+` under both derivation methods (§8). It becomes visible the
moment a third-party client chooses its own id scheme — a UUID with hyphens, a
path-like id, or `crosspoint-sync`'s advertised
`[A-Za-z0-9._-]{1,64}` (`crosspoint-sync docs/API.md:42-44`), all of which can
be written and never read back.

**A new server SHOULD NOT reproduce this.** Either reject on `PUT` what you
cannot serve on `GET`, or accept a wider character set on both.

**[K-GET-2]** When a position exists, the response is **200** with

| Field | Type | Present when |
|---|---|---|
| `document` | string | any other field is present |
| `percentage` | number | stored |
| `progress` | string | stored |
| `device` | string | stored |
| `device_id` | string | stored (omitted if the pushing client never sent one) |
| `timestamp` | number | stored |

An unmerged proposal adds an optional `ids` query parameter and two more
response fields to this endpoint; it is described in §5.8 and is not part of
conformance. A request that does not send `ids` is answered as below.

`syncs_controller.lua:193-226`. Each field is emitted only if the Redis hash
returned a non-`null` value for it, and `document` is added **only if at least
one other field is present** (`:221-224`):

```lua
if next(res) then
    -- We do not want to have an almost empty table with document field only.
    res.document = doc
end
```

**[K-GET-3] An unknown document returns `200` with an empty JSON object — not
`404`.** This is the most frequently reimplemented-wrong behaviour in the
protocol. It is asserted by the reference server's own test suite
(`koreader-sync-server spec/controllers/1/syncs_controller_spec.lua`,
*"cannot get progress of non-existent document"*):

```lua
local response = get(username, userkey, doc .. "non_existent")
assert.are.same(200, response.status)
assert.are.same({}, response.body)
```

The client depends on this. It tests for the *absence of a field*, not for a
status code (`koreader plugins/kosync.koplugin/main.lua:851-859`):

```lua
if not body.percentage then
    if interactive then
        UIManager:show(InfoMessage:new{
            text = _("No progress found for this document."),
            timeout = 3,
        })
    end
    return
end
```

A 404 reaches the client as `ok == false` (`KOSyncClient.lua:169`), which is
rendered as a *sync error* rather than as "you have not read this before".

**[measured]** against the reference server (`koreader/kosync:latest`) on 2026-09-21:

```
$ curl -s -D- -H 'Accept: application/vnd.koreader.v1+json' \
    -H 'x-auth-user: refuser1' -H 'x-auth-key: <md5(password)>' \
    'http://127.0.0.1:8080/syncs/progress/59d481d168cca6267322f150c5f6a2a3'
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 205

{"device_id":"1A2B3C4D5E6F",
 "progress":"\/body\/DocFragment[11]\/body\/div\/p[7]\/text().123",
 "document":"59d481d168cca6267322f150c5f6a2a3","percentage":0.4213,
 "timestamp":1790006348,"device":"Kobo_clara"}

$ curl ... 'http://127.0.0.1:8080/syncs/progress/neverseenatall0000000000000000ff'
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 2

{}
```

Two things to notice. **Key order is not stable** — it is Lua table iteration
order, so do not write a client that depends on it. And **the reference server
escapes forward slashes**, emitting `\/` for `/`: that is `cjson`'s default
`escape_forward_slash` setting. It is valid JSON and every parser undoes it,
but a client comparing raw response text rather than parsed values will not
match an XPointer it sent. A server is not required to reproduce the escaping;
`[K-FLD-3]` is about the *parsed* value round-tripping.

### 5.6 `DELETE /users/me`

Not called by the reference client. Added to the reference server in
`Add authenticated account deletion`; documented at
`koreader-sync-server README.md:67-80`.

Credentials come from the headers; there is no body.

| Outcome | Status | `code` | Body |
|---|---|---|---|
| Deleted | 200 | — | `{"deleted":true}` |
| Wrong key, or missing/invalid headers | 401 | 2001 | error envelope |
| No such account | 404 | 2006 | `Account not found.` |

`syncs_controller.lua:135-154`, `config/errors.lua:23`.

**[K-DEL-1]** Deletion removes the credential key and every key under the
prefix `user:<username>:`, in one Redis Lua script, with a `SCAN` loop and a
`string.sub` prefix test rather than a glob (`syncs_controller.lua:27-52`).

**[K-DEL-2]** The 404/2006 answer is emitted **after** removing any orphaned
data, and exists so that a client which lost the response to a first
`DELETE` can distinguish "already deleted" from "wrong credentials"
(`README.md:74-76`). It is not a generic not-found.

**[K-DEL-3]** No tombstone is kept. A username may be re-registered
immediately. The README warns that the replacement password should differ,
because otherwise a replayed deletion request is indistinguishable from a new
one (`README.md:78-80`).

### 5.7 `PUT /users/password`

Not called by the reference client. `koreader-sync-server README.md:82-95`.

**Request body:** `{"password": "<new credential>"}` — again the *derived* key,
not a plaintext password.

| Outcome | Status | `code` | Body |
|---|---|---|---|
| Updated | 200 | — | `{"updated":true}` |
| Wrong current key, missing/invalid headers | 401 | 2001 | error envelope |
| Empty or non-string replacement, non-object body | 403 | 2003 | error envelope |

`syncs_controller.lua:156-178`.

**[K-PWD-1]** The check-and-set is one Redis Lua script keyed on the *current*
credential, so two concurrent changes using the same current key cannot both
succeed (`syncs_controller.lua:64-72`). A retry with the now-stale key returns
401; the README's recovery advice is to confirm with `GET /users/auth`
(`README.md:93-95`).

**[K-PWD-2]** Stored progress is preserved. Document keys are not touched.

### 5.8 Optional identifier matching — **PROPOSED, NOT MERGED**

> **Status: proposed.** Everything in this section describes
> `koreader/koreader-sync-server` **pull request #55**, which is **open and not
> merged**. No released server implements it. If #55 is merged in a different
> shape, this section is wrong and not the server.
>
> Every `[K-ID-…]` requirement is `MAY`, under the optional feature
> `identifiers` (§12.5). Implementing the section is optional and a server that
> ignores the fields below stays conformant; a server that implements it is
> held to all of them, so `MUST` below means "if you implement this".

| | |
|---|---|
| Upstream PR | [`koreader/koreader-sync-server#55`](https://github.com/koreader/koreader-sync-server/pull/55) |
| Wire shape described here | branch `multi-identifier-aliases` at `0c0f5ad4eedf31668a6ca7646ed8ae9a9c4ed853` (`pid1/koreader-sync-server`, 2026-09-22) |
| Built and run for this section | that branch under OpenResty 1.29.2.3 with Redis 8.10.2, `GIN_ENV=test`, on 2026-09-22 |

Citations in this section are to that branch, not to the pinned reference
commit of §1.1, and are written `identifiers.lua:7` for
`lib/identifiers.lua`.

**The problem.** `document` is one digest of one file (§8). A reader who
recompresses an EPUB, re-downloads it from another shop, or converts it gets a
different digest and loses the position, even though it is the same book.
There is no way to say "this file is also known as" in v1.

**The shape.** Both progress endpoints take an optional, ordered list of
identifiers. A request that names none is answered exactly as it is today.

#### Request

`PUT /syncs/progress` takes an optional `identifiers` array beside the existing
fields:

```json
{"document": "C1",
 "identifiers": [{"type": "content",   "value": "C1"},
                 {"type": "structure", "value": "S1"},
                 {"type": "filename",  "value": "F"}],
 "percentage": 0.32, "progress": "/body/DocFragment[20]/body/p[22]",
 "device": "my kpw"}
```

`GET /syncs/progress/:document` takes the same list flattened into one `ids`
query parameter, because a GET has no body and repeated query parameters are
not reliably ordered (`identifiers.lua:92-94`):

```
GET /syncs/progress/C1?ids=content:C1,structure:S1,filename:F
```

An entry is a `{type, value}` pair. `type` is an **opaque label chosen by the
client**: the server stores and echoes it without interpreting it, so a new
kind of identifier needs no server change (`identifiers.lua:1-3`).

##### Type registry

`type` is opaque **to the server**, which stores and echoes it without
interpreting it. It is not opaque to clients: `progress_match` is a trust
signal, and a client decides whether to follow another device's `progress`
string on the strength of a shared label. Two clients that compute the same
label differently therefore disagree about what they have agreed on, so a label
without a recipe is not interoperable.

| `type` | value | changes when |
|---|---|---|
| `content` | the document's own digest over the file bytes, as §8 derives it | any byte of the file changes |
| `structure` | md5 over the spine, as defined below | the edition, or the chapter list or its order, changes |
| `filename` | md5 of the file name, as §8.5 derives it | the file is renamed |

**[K-ID-15]** A client **offers only the types it can compute honestly.** The
registry is not a set a client has to fill: a type whose recipe it cannot follow
for the book in hand is omitted, not approximated. A client that can derive no
identifier but `document` itself has nothing to say and sends no list at all,
which is the request in §5.4 exactly as it was. Substituting a value that merely
resembles a registered type is worse than omitting it — a digest over a title
dressed up as `filename` is the `metadata` type this section removed, and
`[K-ID-12]` will make one bad match permanent.

**[K-ID-14]** A client **MUST NOT** treat a `progress_match` type it does not
recognise as sufficient to follow a `progress` string. An unrecognised label
carries no guarantee about the file the position was written against, so it is
`percentage` that applies, not the stored position.

The same applies to anything **derived** from that string, not only to following
it. A client that resolves the stored position against the local book to compare
it with the local one — for conflict detection, for a preview, for deciding
whether to prompt — is resolving a position from a file it may not share, and the
number it gets back looks authoritative. Gating only the jump leaves that number
free to suppress a conflict prompt, at which point the position is overwritten
with no one asked. Where the match is not one the client may follow, `percentage`
is the only comparable quantity.

`structure` is computed from the OPF, and two clients have to compute it
identically or the label means nothing. The recipe, exactly:

1. Take the `<package>` element's `unique-identifier` attribute and find the
   `<dc:identifier>` whose `id` matches it — the first, if several do. Trim it.
   If the result is empty, or no element matches, fall back to the first
   `<dc:identifier>` whose trimmed text is non-empty. That value is the first
   line; if there is none, there is no first line. Trimming removes the XML
   whitespace characters (space, tab, CR, LF) and nothing else.
2. Walk `<spine>` in document order. For each `<itemref>`, resolve its `idref`
   against `<manifest>` and take that item's `href`: **not** percent-decoded,
   **not** resolved against the OPF directory, **not** reduced to a basename.
   Strip a `#fragment` if one is present. Each is a line, in spine order.
3. Join the lines with `\n`, with no trailing newline, and take the md5 of the
   UTF-8 bytes.

A container with no spine, or one that is not an OPF-bearing archive, has no
`structure` digest and the identifier is omitted rather than guessed.

The rest of the recipe, because two implementations will otherwise each make a
defensible choice and disagree:

- **Every value here is the one an XML parser yields, with entity references
  expanded** — the identifier, the hrefs and `full-path` alike. An `href` written
  `a&amp;b/ch2.xhtml` contributes the thirteen characters `a&b/ch2.xhtml`. Raw
  source bytes are used nowhere. Expanding is what a parser does without being
  asked; keeping a value raw means going out of its way, and a rule that is
  harder to obey is one two implementations will obey differently.
- **Element names are matched on the local name**, so `<opf:spine>` and
  `<spine>` are the same element and `<identifier>` under a default Dublin Core
  namespace counts as `<dc:identifier>`. **Attribute names are matched
  literally and unprefixed** — `href`, `id`, `idref`, `full-path`, `media-type`,
  `unique-identifier`. An unprefixed attribute is in no namespace, so `opf:href`
  is a different attribute rather than the same one, and the package format
  writes these unprefixed.
- **An element's value is its complete character data, concatenated**, not the
  first text node. A parser may split a run at an entity reference or a buffer
  boundary, and two that split differently must still agree.
- **Only the five predefined XML entities and numeric character references are
  expanded**: `&amp; &lt; &gt; &quot; &apos;`, `&#nnn;` and `&#xHH;`. Any other
  undeclared reference makes the document not well-formed, and a digest taken
  from one is undefined rather than wrong — a conforming parser rejects the
  document where a lenient one may expand an HTML name it happens to know.
- A package that puts `<item>` outside `<manifest>` is malformed, and resolves
  no spine entry, so it has **no** `structure` digest rather than one computed
  from whatever was found elsewhere.
- **At least one spine line is required.** A digest of the identifier alone is
  not a `structure` digest, so a package whose `<itemref>`s all dangle has none,
  the same as one with no `<spine>` at all.
- Two `<item>` elements carrying the same `id`: the **first**, as for
  `<dc:identifier>`.
- **An `href` is not trimmed.** Step 1 trims the identifier and nothing else
  does; leading or trailing space inside the attribute is part of the value.
- **An `<itemref>` whose `idref` resolves to no manifest item contributes no
  line**, and does not invalidate the digest. So does one that resolves to an
  `<item>` carrying no `href`: no href, no line, rather than an empty one.
- **`linear="no"` items are included.** They are spine entries, and the
  renderer's `DocFragment` numbering counts them.
- `<item>` is looked up within `<manifest>`, `<itemref>` within `<spine>`, and
  `<dc:identifier>` within `<metadata>`.
- **The OPF is the first `<rootfile>` whose `media-type` is
  `application/oebps-package+xml`**, or the first `<rootfile>` of any type when
  none declares it. Its `full-path`, as the parser yields it, is the archive
  member name; if no member matches, there is no digest rather than a guessed
  one. Preferring
  the declared package document keeps this from disagreeing with whatever a
  reader already opens for a multi-rendition container.

`structure` deliberately covers **no file contents.** The tools that motivate
this section rewrite them: CrossPoint's EPUB optimizer re-encodes images to
JPEG through a canvas, injects a stylesheet into every chapter's `<head>` and
rewrites `<img src>` when it splits an image, so every entry's bytes change
while the spine does not. A digest over entry CRCs survives recompression and
fails against the very tool this exists for. The spine href list is also exactly
what an xpointer counts — `/body/DocFragment[N]` is the Nth spine entry — so a
`structure` match says precisely that the position's chapter index means the
same thing here.

**There is no `metadata` type.** A digest over title and author is the only
identifier that can match two genuinely different files, and `[K-ID-12]` never
repoints an alias. Two books a library has tagged alike merge on it, and until
`[K-ID-12b]` the merge outlived the tagging being corrected. The recompression
case is covered by `structure`, so the type bought cross-edition matching at the
cost of the only unrecoverable failure in the section.

| Rule | Value | Citation |
|---|---|---|
| Maximum entries per request | **8** | `identifiers.lua:7` |
| `type` pattern | `^[a-z][a-z0-9-]*$`, at most 32 characters | `identifiers.lua:8,14` |
| `value` pattern | `^[A-Za-z0-9][A-Za-z0-9-_.]*$`, at most 128 characters | `identifiers.lua:9,15` |
| Duplicate `type` in one list | rejected | `identifiers.lua:82-85`, `:119-122` |
| Empty list | rejected | `identifiers.lua:64-66` |
| Order | the client's **order of preference**, strongest first — required, see `[K-ID-5b]` | `identifiers.lua:49-50` |

**[K-ID-8]** The list **MUST contain an entry whose `value` equals `document`**
(`syncs_controller.lua:197-202`). A list that does not is rejected with **403**
code **2003**, on both the write and the read. This is what keeps `document`
meaning *"the identifier I would send if you only took one"*: the record stays
addressable by the digest a client naming no identifiers sends, and a read that
names none follows no alias to reach it (`[K-ID-1b]`).

**[K-ID-8b]** That entry **need not be first.** Position in the list carries
preference, not identity. When nothing resolves, the record is created under
`document` rather than under the first entry, and `match` is that entry's type
(`syncs_controller.lua:104-109`). Pinning it to the first position would force a
client whose `document` digest is its weakest identifier to offer that one first
and be matched on it — which is what KOReader sends when its document matching
is set to the filename, and it would report `progress_match: "filename"` for a
copy whose content is byte-identical.

**[K-ID-9]** A list of more than **8** entries is rejected with **403** code
**2003** (`identifiers.lua:67-69`, `:103-105`). Exactly 8 is accepted. Each
identifier costs a lookup on the read path and a possible alias write on the
write path, so the cap is what bounds one request's work.

#### Response

**[K-ID-2]** A `PUT` that names identifiers returns **200** with exactly three
fields (`syncs_controller.lua:500-504`):

```json
{"document": "C1", "match": "content", "timestamp": 1790124995}
```

`document` is the **canonical** digest the record is stored under, which is not
necessarily the one the request sent. There is no `progress_match` on a write:
the writer is the request itself.

**[K-ID-3]** `match` is the `type` of the identifier that **resolved the
lookup**, reported with the *caller's* own label. For a record being created it
is the first entry's type, since that is what the record is created under
(`syncs_controller.lua:98-100`).

A `GET` that names identifiers returns today's fields plus two:

| Field | Type | Meaning |
|---|---|---|
| `match` | string | the identifier type that **found** the record |
| `progress_match` | string | the strongest identifier the caller shares with whoever **wrote the current `progress` string**, or `"none"` |

**[K-ID-6]** `match` and `progress_match` answer different questions and
routinely differ. A reader can match a record on its own content digest —
`match: "content"`, the record is literally its file — while the position
stored there was written by a different book that only shared the file name:
`progress_match: "filename"`. The first says *we found your book*, the
second says *how much you should trust this xpointer*. Only `progress_match`
bears on whether the position can be followed
(`syncs_controller.lua:350-361`, `identifiers.lua:180-195`).

`progress_match` is computed against the identifiers stored **beside the
progress string they were written with** (`identifiers_for`), not against
whatever the record last saw, so identifiers are never attributed to a string
their owner did not write (`syncs_controller.lua:426-431`, `:356`). Two
consequences:

- **[K-ID-6b]** `"none"` when the caller and the writer share no value at all.
- **[K-ID-6c]** When the current `progress` was written by a request that named
  **no** identifiers, the record is treated as written by the digest it is
  stored under, so `progress_match` equals `match` (`syncs_controller.lua:360`).

**[K-ID-1]** A request that names **no** identifiers gets **exactly today's
response**: `{document, timestamp}` on the write, the §5.5 body on the read,
**with neither `match` nor `progress_match`**, and the read **follows no
alias** — it looks up the literal `document` and nothing else
(`syncs_controller.lua:378-386`). An existing client sees no change of any
kind.

**[K-ID-11]** A document that matches nothing, under any identifier offered,
is still **200 with an empty body** — `[K-GET-3]` is unaffected, and there are
no matching fields to report on a miss (`syncs_controller.lua:318-320`,
`:346-348`).

#### Resolution and aliases

Identifiers other than the record's own become **aliases**: per account,
`user:<username>:alias:<value>` holding `<type>:<canonical>`.

Resolution walks the caller's list **in order**, and for each entry tries the
value as a document first and as an alias second, stopping at the first hit
(`syncs_controller.lua:84-97` on the write, `:131-141` on the read).

**[K-ID-5]** Because the walk is in the caller's order, the same three
identifiers offered strongest-first and weakest-first resolve through different
entries and report different `match` values. The list is a preference order,
not a set; a server that resolves in its own order gives two clients different
answers about the same book.

**[K-ID-5b]** A client **MUST** order its identifiers strongest first — most
specific to the file in hand, least specific last. The registry table above is
in descending strength order for the types it names. This is not a stylistic
preference: `[K-ID-12b]` is the protection against a wrong match becoming
permanent, it is expressed in terms of list position, and a list that opens with
its weakest identifier matches at the first position and so registers every
identifier behind it. **Measured 2026-09-23** against the branch above with the
`[K-ID-12b]` rule in place: two books sharing only a weak identifier, offered
weakest-first, merge and stay merged after the weak identifier is corrected — the
same failure `[K-ID-12b]` exists to prevent, reproduced with nothing but a
different list order. A server cannot check this (§12.4).

**[K-ID-4]** A copy that shares any identifier with a record the account
already holds resolves to that record, and the response carries the
**canonical** digest so the next request can address it directly.

**[K-ID-7]** An alias **MUST NOT shadow a document that exists in its own
right.** The walk tests `EXISTS document:<value>` before consulting the alias
table, and an alias is created only for a value that is not already a document
(`syncs_controller.lua:87-88`, `:104`). A weak identifier can therefore fail to
match, but it cannot move one book's position onto another book's record.

**[K-ID-12]** An alias is **created, never repointed.** The write path writes
an alias only when none exists, or when the one that exists points at a
document that is gone (`syncs_controller.lua:115-120`). A digest that has
resolved to a record keeps resolving to it.

**[K-ID-12b]** An identifier the caller ranks **above** the one that matched is
**not registered at all** (`syncs_controller.lua:110`). Matching on a weak
identifier is a guess; registering the caller's stronger digests as aliases to
that guess would make a wrong one permanent, because `[K-ID-12]` never repoints
and no endpoint unlinks. Two books a library has tagged alike share only their
weakest identifier, and without this rule the second one pushed takes the first
one's record, overwrites the position stored there, and cannot be separated
again by correcting the tagging — its own content digest has been glued to the
other record on the way through. Confining a wrong guess to the identifier that
made it is what makes it recoverable. On a **create** the record is the caller's
own, so every identifier it offers describes it and all of them are registered.

What this rule recovers is the **copy**, not the position: the intruding push
still overwrote what was stored on the other record, and nothing restores that.
It also has a cost on the benign path. A recompressed copy that matched on
`structure` never has its own `content` digest registered, on that push or any
later one, so it depends on the weaker identifier continuing to match and is
orphaned if the spine later changes. That trade is deliberate, and it is a trade.
The rule is only as good as `[K-ID-5b]`, which a server cannot enforce.

**[K-ID-10]** Aliases are namespaced per account, like positions
(`[K-ISO-1]`). **[K-ID-13]** They live under the account's `user:<username>:`
prefix, so `DELETE /users/me` removes them with everything else
(`[K-DEL-1]`).

#### [measured]

Against the branch above at `49dbd38` on 2026-09-23, `GIN_ENV=production`,
plaintext listener, account `reader`. `C1` is the original, `C2` a recompressed
copy of it, and `C3` a different book that happens to carry the same file name.

```
$ curl -X PUT .../syncs/progress -d '{"document":"C1",
    "identifiers":[{"type":"content","value":"C1"},
                   {"type":"structure","value":"S1"},
                   {"type":"filename","value":"F"}],
    "percentage":0.32,"progress":"/body/DocFragment[20]/body/p[22]",
    "device":"my kpw"}'
{"document":"C1","timestamp":1790176644,"match":"content"}

# the recompressed copy: different content digest, same spine
$ curl '.../syncs/progress/C2?ids=content:C2,structure:S1,filename:F'
{"percentage":0.32,"device":"my kpw","progress_match":"structure",
 "progress":"\/body\/DocFragment[20]\/body\/p[22]","document":"C1",
 "timestamp":1790176644,"match":"structure"}

# a different book sharing only the file name writes, and takes the record
$ curl -X PUT .../syncs/progress -d '{"document":"C3",
    "identifiers":[{"type":"content","value":"C3"},
                   {"type":"structure","value":"S3"},
                   {"type":"filename","value":"F"}],
    "percentage":0.5,"progress":"/body/DocFragment[3]/body/p[9]","device":"pb"}'
{"document":"C1","timestamp":1790176644,"match":"filename"}

# the original reads again: found by its own digest, written by the other
$ curl '.../syncs/progress/C1?ids=content:C1,structure:S1,filename:F'
{"percentage":0.5,"device":"pb","document":"C1",
 "progress":"\/body\/DocFragment[3]\/body\/p[9]","progress_match":"filename",
 "timestamp":1790176644,"match":"content"}

# the same read naming no identifiers: today's body, no new fields
$ curl '.../syncs/progress/C1'
{"percentage":0.5,"device":"pb","document":"C1","timestamp":1790176644,
 "progress":"\/body\/DocFragment[3]\/body\/p[9]"}

# a list that names the document nowhere
$ curl '.../syncs/progress/C1?ids=filename:F'
403 {"code":2003,"message":"Invalid request"}
```

Redis after that sequence — one document and **two** aliases, all under the
account:

```
user:reader:alias:F       user:reader:alias:S1
user:reader:document:C1   user:reader:key
```

`C3` and `S3` are absent, and that is `[K-ID-12b]`. The third push matched on
`filename`, the weakest identifier it offered, so the two digests it ranked above
that one were not registered. Had they been, the second book would be reachable
only through the first book's record for good, and correcting the file name would
not undo it. What the rule does not undo is the overwrite: `C1` now holds the
other book's position, and the `my kpw` reading at 0.32 is gone.

#### Running the checks

```bash
node verify.mjs --base-url http://127.0.0.1:8080 \
  --user alice --password hunter2
```

There is no flag. The verifier pushes one position naming identifiers and reads
the answer: a `match` field means the feature is implemented and the family is
checked, and its absence means the family is recorded as `SKIP`.

The identifier checks allocate **fresh digests on every run**, unlike the rest
of the suite, which reuses stable ids by design. They have to: `[K-ID-12]` says
an alias is never repointed, so a second run over the same digests would
resolve through the first run's aliases and assert nothing.


---

## 6. Error model

**[K-ERR-1]** An error response body is a JSON object with exactly two keys,
unless the raising site adds custom attributes (nothing in the reference server
does):

```json
{"code": 2001, "message": "Unauthorized"}
```

`gin gin/core/error.lua:29-49`. The `code` is a framework-level integer, not
the HTTP status.

**[K-ERR-2001]** An authentication failure SHOULD carry `code` 2001
specifically, since it is the one code a caller can act on: it distinguishes a
permanent credential problem, which the client must not retry, from every other
failure, which it queues (§6.4).

### 6.1 Application error codes

`koreader-sync-server config/errors.lua:15-24`, verbatim:

| `code` | HTTP | `message` | Raised by |
|---|---|---|---|
| 1000 | 502 | `Cannot connect to redis server.` | any endpoint, if Redis is down (`syncs_controller.lua:84-91`) |
| 2000 | 502 | `Unknown server error.` | unexpected Redis reply on create/update/delete/password |
| 2001 | **401** | `Unauthorized` | bad or missing credentials, on every authenticated endpoint |
| 2002 | **402** | `Username is already registered.` | `POST /users/create`, name taken |
| 2003 | **403** | `Invalid request` | invalid registration fields; invalid password-change body; missing `percentage`/`progress`/`device` on PUT |
| 2004 | **403** | `Field 'document' not provided.` | missing/invalid `document` on PUT or GET |
| 2005 | **402** | `User registration is disabled.` | `POST /users/create` when registration is off |
| 2006 | **404** | `Account not found.` | `DELETE /users/me` for an unknown account |

### 6.2 Framework error codes

`gin gin/core/error.lua:18-22`. These are emitted before the application sees
the request.

| `code` | HTTP | `message` |
|---|---|---|
| 100 | 412 | `Accept header not set.` |
| 101 | 412 | `Invalid Accept header format.` |
| 102 | 412 | `Unsupported version specified in the Accept header.` |
| 103 | 400 | `Could not parse JSON in body.` |
| 104 | 400 | `Body should be a JSON hash.` |

### 6.3 Overloaded codes and statuses

These are the places where a status or a code does not identify a condition.
A reimplementer who wants to be distinguishable must emit the `code`.

| Ambiguity | Detail |
|---|---|
| **HTTP 402 means two different things** | 2002 "username taken" and 2005 "registration disabled" share a status. Only `code` separates them. 402 Payment Required is used because `api.json:16` declares `[201, 402]` and Spore raises on an undeclared status. |
| **HTTP 403 means two different things** | 2003 "invalid request" and 2004 "document field missing". |
| **`code` 2003 covers three conditions** | invalid registration fields; invalid password-change body; missing `percentage`/`progress`/`device` on PUT. |
| **`code` 2001 covers three conditions** | no headers; unknown user; wrong key. Deliberate — it prevents username enumeration. |
| **`code` 2004's message is wrong for GET** | `Field 'document' not provided.` is raised when the *path segment* is invalid, where nothing was "not provided". |
| **HTTP 401 vs 404 on a deleted account** | `DELETE /users/me` is the only endpoint that distinguishes them (2006). Every other endpoint answers 401 for a missing account. |
| **HTTP 502 is a real application answer** | codes 1000 and 2000 are 502. A proxy or client that treats 5xx as "server down and retry later" will do the right thing for 1000 and the wrong thing for 2000. |

### 6.4 What the reference client does with errors

- `register`: success is `status == 201`; anything else shows `body.message`
  (`main.lua:591-594`). The numeric `code` is never read.
- `authorize`: success is `status == 200`
  (`KOSyncClient.lua:99`).
- `update_progress`: success is `status == 200`. **On any other status except
  401, the update is queued for retry** (`main.lua:770-777`):

  ```lua
  -- Queue for retry unless it's an auth failure
  if status ~= 401 then
      local KOSyncQueue = require("KOSyncQueue")
      KOSyncQueue:push(queue_item)
  end
  ```

  The queue keeps one entry per document per day, expires entries after four
  weeks and caps at 200 entries
  (`koreader plugins/kosync.koplugin/KOSyncQueue.lua:5-7`, `:39-61`).
  A server that answers a *permanent* error with anything but 401 therefore
  causes an unbounded-in-time retry loop, not a clean failure.
- `get_progress`: success is `status == 200` (`KOSyncClient.lua:169`), then
  the body is inspected for `percentage` (§5.5).
- The reference client **never reads the numeric `code`.** It is for humans and
  for other clients.

---

## 7. Field semantics

### 7.1 `document`

**[K-FLD-1]** An opaque, non-empty string without a colon. The server stores
it as part of a key and never interprets it. §8 covers how KOReader derives it.

In practice it is always a 32-character lowercase hex MD5, because both
derivation methods produce one — but nothing in the protocol requires that, and
a server that validates the shape will reject clients that choose otherwise.

### 7.2 `progress`

**[K-FLD-2]** `progress` is a **string**, always, even when it looks like an
integer. The reference client stringifies it explicitly before sending
(`koreader plugins/kosync.koplugin/KOSyncClient.lua:131`):

```lua
progress = tostring(progress),
```

Its content depends on the document type
(`koreader plugins/kosync.koplugin/main.lua:658-664`, `:705-712`):

| Document kind | `progress` is | Example |
|---|---|---|
| Reflowable (EPUB, FB2, …) — `has_pages == false` | a CRe **XPointer** | `/body/DocFragment[11]/body/div/p[7]/text().123` |
| Paged (PDF, DjVu, CBZ, …) — `has_pages == true` | a **page number**, as a decimal string | `"56"` |

The client dispatches on its own document type, not on the value's shape, when
applying a pulled position (`main.lua:705-712`):

```lua
function KOSync:syncToProgress(progress)
    if self.ui.document.info.has_pages then
        self.ui:handleEvent(Event:new("GotoPage", tonumber(progress)))
    else
        self.ui:handleEvent(Event:new("GotoXPointer", progress))
    end
end
```

**[K-FLD-3]** A server MUST round-trip `progress` byte-for-byte as a string. A
server that stores it as a number destroys every EPUB position. A server that
stores `"56"` as `56` and returns it as a JSON number will *usually* still
work, because `tonumber` is applied for paged documents — but it will break
`body.progress == progress` in the client's already-synchronised check
(`main.lua:877-878`), producing a spurious sync prompt on every pull.

The reference server stores it in a Redis hash field, which is inherently a
string, and returns it unconverted (`syncs_controller.lua:208-210`).

### 7.3 `percentage`

**[K-FLD-4]** A JSON number in `[0, 1]`. Emitted by
`Math.roundPercent(...)` on the client (`main.lua:650-656`), and read back with
`tonumber` on the reference server (`syncs_controller.lua:206`).

**[K-FLD-5]** The reference server does **not** range-check it. Redis stores
the stringified number and returns it via `tonumber`, so precision is that of
Lua's `%.14g` formatting. The README's own example shows
`"0.31879884821061"` — 14 significant digits
(`koreader-sync-server README.md:106`).

Clients round it before comparing (`main.lua:872`:
`body.percentage = Math.roundPercent(body.percentage)`), so a server that
stores a float64 and returns full precision is safe.

`percentage` is the field the client tests for presence to decide whether a
document is known (§5.5). **A server MUST NOT return a `percentage` key for a
document it has never been told about.**

### 7.4 `device`

**[K-FLD-6]** A human-readable device name, shown verbatim in the client's
sync prompt (`main.lua:909-912`). Defaults to `Device.model`, overridable by
the user as `kosync_hostname` (`main.lua:741`):

```lua
local chosen_device_name = self.settings.kosync_hostname or Device.model
```

Required by the reference server on PUT; returned on GET.

### 7.5 `device_id`

**[K-FLD-7]** An opaque per-device identifier, read from the global setting
`device_id` (`main.lua:99`). Optional on PUT; stored and returned only if sent
(`syncs_controller.lua:256-259`, `:214-216`).

**[K-FLD-8]** Its only protocol role is **self-detection**. On pull, the client
ignores a position that came from itself (`main.lua:861-870`):

```lua
if body.device == Device.model
and body.device_id == self.device_id then
    ...
    return
end
```

Note the asymmetry, which is a live bug rather than a design: the comparison
uses `Device.model`, but the *push* sends
`self.settings.kosync_hostname or Device.model` (`main.lua:741`). **A user who
sets a custom device name defeats self-detection** — their own pushes come back
with `device` set to the custom name, which never equals `Device.model`, so the
device treats its own progress as a peer's. A server cannot work around this.

A server that omits `device_id` from a GET response also defeats self-detection
(`nil == nil` would match, but only if the pushing device also omitted it).

### 7.6 `metadata`

**[K-FLD-9]** An optional object sent only when the user enables *Send document
metadata*, which is **off by default** (`main.lua:66`:
`send_metadata = false`). Its shape (`main.lua:694-703`):

```lua
function KOSync:getMetadata()
    if not self.settings.send_metadata then return end

    local props = self.ui.doc_props
    return {
        filename = self:getFileName(),
        title = props.display_title,
        authors = props.authors,
    }
end
```

| Field | Type |
|---|---|
| `filename` | string — basename only, no directory (`main.lua:684-692`) |
| `title` | string |
| `authors` | string |

**[K-FLD-10]** A server MUST accept `metadata` and MUST NOT fail the request
because of it. **The reference server ignores it entirely** — it is not read
anywhere in `syncs_controller.lua` and is not written to Redis. The client's
own help text says so
(`koreader plugins/kosync.koplugin/main.lua:449`):

> When enabled, document metadata (filename, title, and authors) will be sent
> along with progress sync requests. This data is ignored by the official sync
> server but may be used by custom sync servers.

**[K-FLD-11]** A server that *does* store metadata MUST NOT clear stored values
when a later PUT omits the object. Metadata is off by default and can be turned
off again, and the same account may have devices on both settings; treating
"absent" as "delete" loses data on every push from a device that is not sending
it.

### 7.7 `timestamp`

**[K-FLD-12]** Unix epoch **seconds**, as an integer. Generated by the server
at write time (`syncs_controller.lua:246`), returned by both `PUT` and `GET`.
Never sent by the client.

**[K-FLD-13]** A server MUST return `timestamp` on `GET`. §9 explains what
breaks when it does not. A server SHOULD return it on `PUT`; the reference
client does not read it there, but `api.json` and the reference server both
include it.

**[K-FLD-14]** The unit is seconds, not milliseconds. The client compares it
directly against a device-local `os.time()` value (§9), so a millisecond
timestamp makes every remote position look newer than every local one, forever.

---

## 8. Document identity

`document` is the string both devices must agree on. KOReader offers two ways
to derive it, selected by the `checksum_method` setting.

### 8.1 The `checksum_method` setting

**[K-DOC-1]** Two methods
(`koreader plugins/kosync.koplugin/main.lua:46-49`):

```lua
local CHECKSUM_METHOD = {
    BINARY = 0,
    FILENAME = 1
}
```

**[K-DOC-2]** KOReader defaults to **`BINARY`**
(`main.lua:65`: `checksum_method = CHECKSUM_METHOD.BINARY`). Dispatch
(`main.lua:666-682`):

```lua
function KOSync:getDocumentDigest()
    if self.settings.checksum_method == CHECKSUM_METHOD.FILENAME then
        return self:getFileNameDigest()
    else
        return self:getFileDigest()
    end
end

function KOSync:getFileDigest()
    return self.ui.doc_settings:readSetting("partial_md5_checksum")
end

function KOSync:getFileNameDigest()
    local file_name = self:getFileName()
    if not file_name then return end
    return md5(file_name)
end
```

**[K-DOC-3]** `FILENAME` is the plain MD5 of the **basename** of the file,
directory stripped (`main.lua:684-692`, `util.splitFilePathName`). It exists so
that a re-downloaded or re-converted copy of the same book still matches.

**[K-DOC-4]** The two methods are **not interchangeable and are not
distinguishable on the wire.** Both produce a 32-character lowercase hex
string. Two devices with different `checksum_method` settings silently sync
nothing: each writes under a different key and reads back an empty object. A
server cannot detect or repair this.

**Divergence.** It is sometimes said that a third-party client defaults to the
filename method. Among the clients surveyed for this document that is **not the
case** — `readest` also defaults to binary
(`readest apps/readest-app/src/services/constants.ts:81`:
`checksumMethod: 'binary',`). The real divergence is the opposite: readest has
**removed** filename hashing while keeping the setting. The type still admits
`'filename'` (`src/types/settings.ts:53`), but the settings form offers a single
option (`src/components/settings/integrations/KOSyncForm.tsx:242`:
`options={[{ value: 'binary', label: _('File Content') }]}`) and the client
warns and falls back
(`src/services/sync/KOSyncClient.ts:310-315`):

```ts
  getDocumentDigest(book: Book): string {
    if (this.config.checksumMethod === 'filename') {
      console.warn('This is not possible anymore, using md5 instead.');
    }
    return book.hash;
  }
```

So a user migrating from KOReader with filename matching enabled has no way to
reproduce it, and a persisted `'filename'` setting is silently ignored rather
than honoured or migrated. Kavita and calibre-web-automated are binary-only
(§11.1) — Kavita has a `HashTitle` helper with no callers
(`Kavita.Services/Helpers/KoreaderHelper.cs:76-83`), whose own docstring says
*"For now, we only support by contents."*

### 8.2 The partial MD5 — the algorithm

**[K-DOC-5]** The binary digest is KOReader's *partial* MD5: twelve 1024-byte
samples at exponentially spaced offsets, concatenated in offset order and
hashed once.

The implementation is `util.partialMD5`, at
`koreader frontend/util.lua:1094-1112`, verbatim:

```lua
function util.partialMD5(filepath)
    if not filepath then return end
    local file = io.open(filepath, "rb")
    if not file then return end
    local step, size = 1024, 1024
    local update = md5()
    for i = -1, 10 do
        file:seek("set", lshift(step, 2*i))
        local sample = file:read(size)
        if sample then
            update(sample)
        else
            break
        end
    end
    file:close()
    return update()
end
```

`lshift` is `bit.lshift` (`koreader frontend/util.lua:13`); `md5` is
`require("ffi/sha2").md5` (`frontend/util.lua:8`), returning lowercase hex.

The design intent is stated in the function's own comment
(`frontend/util.lua:1085-1093`): KOReader appends data to PDFs when
highlighting, so the sampling is weighted towards the head of the file to keep
the digest stable under appends.

### 8.3 The `i = -1` term, and why the first offset is 0

For `i = -1` the shift count is `2 * -1 = -2`. There are two readings:

- **Arithmetic:** a left shift by −2 is a right shift by 2, giving
  `1024 >> 2 = 256`.
- **Bitwise:** LuaJIT's `bit` library (LuaBitOp semantics) **masks the shift
  count to five bits**, so `-2` becomes `30`, and `1024 << 30` is `2^40`, which
  truncates in 32 bits to **0**.

**[K-DOC-6] The bitwise reading is the one that runs. The first sample offset
is 0.**

This was settled two independent ways.

**First, by running LuaJIT** [measured]:

```
$ luajit -e 'local bit=require("bit")
             print(bit.lshift(1024,-2), bit.band(-2,31), bit.lshift(1024,30))'
0	30	0
```

LuaJIT 2.1.1788856981 on `darwin-arm64`. Both routes agree: masking `-2` to
`30` and shifting `1024` left by 30 overflows 32 bits to `0`.

**Second, and decisively, by reproducing KOReader's own golden vectors**
[measured]. `koreader spec/unit/util_spec.lua:338-345` pins two digests:

```lua
describe("partialMD5()", function()
    it("should calculate partial md5 hash of pdf file", function()
        assert.is_equal(util.partialMD5("spec/front/unit/data/tall.pdf"), "41cce710f34e5ec21315e19c99821415")
    end)
    it("should calculate partial md5 hash of epub file", function()
        assert.is_equal(util.partialMD5("spec/front/unit/data/leaves.epub"), "59d481d168cca6267322f150c5f6a2a3")
    end)
end)
```

Those files are `leaves.epub` and `tall.pdf` from `koreader/test-data`
(`c3b5d06`). Transcribing the loop into LuaJIT and taking the MD5 of the
concatenated samples with each reading of `i = -1`:

| File | Size (B) | First offset **0** | First offset **256** |
|---|---|---|---|
| `leaves.epub` | 881,331 | `59d481d168cca6267322f150c5f6a2a3` ✅ **matches** | `566aa9554a1428eb7234ffd9f2d41f7b` ✗ |
| `tall.pdf` | 388,039 | `41cce710f34e5ec21315e19c99821415` ✅ **matches** | `0a829912b6ff9584d5b0f461f54a31ca` ✗ |

The question is therefore closed against KOReader's own test suite, not merely
against LuaJIT's shift semantics. **An implementation whose first sample offset
is 256 is wrong.** An implementation that omits the `i = -1` sample entirely —
eleven samples instead of twelve — is also wrong, and differs from a correct
one on every file larger than 1024 bytes.

### 8.4 The twelve offsets

**[K-DOC-7]** Enumerated by running the exact shift expression in LuaJIT 2.1
[measured]:

| `i` | `2*i` | `lshift(1024, 2*i)` — **the offset used** | `1024 * 4^i` (arithmetic, for contrast) |
|---:|---:|---:|---:|
| −1 | −2 | **0** | 256 |
| 0 | 0 | 1,024 | 1,024 |
| 1 | 2 | 4,096 | 4,096 |
| 2 | 4 | 16,384 | 16,384 |
| 3 | 6 | 65,536 | 65,536 |
| 4 | 8 | 262,144 | 262,144 |
| 5 | 10 | 1,048,576 | 1,048,576 |
| 6 | 12 | 4,194,304 | 4,194,304 |
| 7 | 14 | 16,777,216 | 16,777,216 |
| 8 | 16 | 67,108,864 | 67,108,864 |
| 9 | 18 | 268,435,456 | 268,435,456 |
| 10 | 20 | 1,073,741,824 | 1,073,741,824 |

Only the first row differs. Offsets 0 and 1024 are contiguous and
non-overlapping, so the first two samples together cover `[0, 2048)`.

**[K-DOC-8]** The loop stops at the **first** offset at or beyond EOF, and does
not resume. `file:read(1024)` past EOF returns `nil`, which breaks the loop. A
file of `n` bytes therefore yields:

| File size | Samples taken | Bytes hashed |
|---|---|---|
| `n ≤ 1024` | 1 | `n` |
| `1024 < n ≤ 4096` | 2 | `min(n, 2048)` |
| `4096 < n ≤ 16384` | 3 | `2048 + min(n − 4096, 1024)` |
| … | … | … |
| `n > 1,073,741,824` | **12** | `11264 + min(n − 1073741824, 1024)` |

**[K-DOC-9]** The final sample is **truncated, not padded**, when fewer than
1024 bytes remain.

**[K-DOC-10]** A maximum of 12 KiB is ever read, regardless of file size. The
digest is cheap on a 2 GB file and on a 2 KB file alike.

### 8.5 Collision properties a reimplementer should know

- Because at most 12,288 bytes are hashed, **the digest is not a content
  hash.** Any two files that agree on the sampled windows collide.
- **Size only matters through the sample count.** [measured] a 2,048-byte file
  and a 3,000-byte file whose first 2,048 bytes agree produce the identical
  digest `d0e59a0c7b893c3b8d6a9bddbd64e631`, because both take exactly the
  samples at 0 and 1024 and both fill them completely. The file length is not
  an input.
- The function's own comment warns that a PDF whose size is near one of the
  offsets can change digest when KOReader appends a highlight, because the
  sample count changes (`frontend/util.lua:1090-1093`).
- `util.partialMD5` returns `nil` for a missing or unreadable path
  (`frontend/util.lua:1095-1097`). The kosync plugin does not compute the
  digest itself — it reads a cached one from the document's sidecar
  (`main.lua:674-676`), written once at open time by
  `koreader frontend/apps/reader/readerui.lua:497-501`. A `nil` digest
  propagates into the request as a missing `document` field.

### 8.6 Golden test vectors

All vectors below were **computed on 2026-09-21** by two independent
implementations that agree: a verbatim LuaJIT transcription of
`util.partialMD5` (samples piped to `md5(1)`), and a separate Node
implementation of the same rule. Reproduction commands are in §13.2.

**Vectors from KOReader's own fixtures** — these also appear in
`koreader spec/unit/util_spec.lua`:

| File (`koreader/test-data@c3b5d06`) | Size (B) | Samples | Partial MD5 |
|---|---:|---:|---|
| `leaves.epub` | 881,331 | 6 | `59d481d168cca6267322f150c5f6a2a3` |
| `tall.pdf` | 388,039 | 6 | `41cce710f34e5ec21315e19c99821415` |

**Synthetic vectors.** Let `P(n)` be the `n`-byte file whose byte at index `i`
(0-based) is:

```
P(n)[i] = (i * 31 + (i >> 8)) mod 256
```

| File | Size (B) | Samples | Offsets sampled | Partial MD5 |
|---|---:|---:|---|---|
| `P(500)` | 500 | 1 | 0 (500 B, short) | `21f0df72cce9bc7da8dae2512ee5feed` |
| `P(1024)` | 1,024 | 1 | 0 | `f4cd1641040a17288bb6104d9e66bdb5` |
| `P(1025)` | 1,025 | 2 | 0, 1024 (1 B, short) | `170a888db01c00d8fc3e5d8d84de5838` |
| `P(2048)` | 2,048 | 2 | 0, 1024 | `d0e59a0c7b893c3b8d6a9bddbd64e631` |
| `P(3000)` | 3,000 | 2 | 0, 1024 | `d0e59a0c7b893c3b8d6a9bddbd64e631` |
| `P(200000)` | 200,000 | 5 | 0 … 65536 | `1784b150454ef4cf6780ceb94af0386f` |
| `P(1050000)` | 1,050,000 | 7 | 0 … 1048576 | `0fca5c751677ecbc2dcfe80ea75ace32` |

`P(2048)` and `P(3000)` sharing a digest is the collision property of §8.5, not
a transcription error.

**A vector exercising all twelve samples.** A file larger than 1 GiB is needed
to reach `i = 10`. Define `S` as a **sparse** file of exactly
`1073742848` bytes (`1 GiB + 1024`) that is zero everywhere except that, at
each of the twelve offsets in §8.4, the 16 ASCII bytes of that offset written
as a zero-padded decimal are stored — `0000000000000000` at offset 0,
`0000000000001024` at offset 1024, …, `0000001073741824` at offset
1,073,741,824.

| File | Size (B) | Samples | Partial MD5 |
|---|---:|---:|---|
| `S` | 1,073,742,848 | **12** | `266ff27c24919f4cec96f90f9b3231ca` |

On APFS this occupies about 17 MB on disk. Generator source: §13.2.

`P(200000)`'s digest is independently pinned in tsundoku's unit suite
(`test/unit/partialmd5.test.ts:103-108`), which is how the TypeScript
implementation is checked against the Lua rather than against a reading of it.

### 8.7 The 256-offset variant

Some implementations — including, historically, tsundoku — compute the
arithmetic reading (first offset 256) as well. §8.3 shows it is not what
KOReader produces. It is listed here only so the digests are identifiable if
they turn up in a database:

| File | 256-variant digest |
|---|---|
| `leaves.epub` | `566aa9554a1428eb7234ffd9f2d41f7b` |
| `tall.pdf` | `0a829912b6ff9584d5b0f461f54a31ca` |
| `P(200000)` | `a4c467911c7cce46aa803a42866f5ac1` |

**[unverified]** No KOReader build has been observed writing a 256-variant
digest to a sidecar. Confirming what a *specific* KOReader binary writes needs
a device: open a known file, then read `partial_md5_checksum` out of
`<book>.sdr/metadata.<ext>.lua`. The reproduction above proves the algorithm
as KOReader's own test suite defines it, which is a stronger guarantee than one
device would give, but it is not the same guarantee.

---

## 9. Conflict resolution

**[K-SYNC-1]** All conflict resolution is client-side. The server never
compares, merges or rejects; §5.4 `[K-PUT-5]`.

The client's pull path is
`koreader plugins/kosync.koplugin/main.lua:841-933`. In order:

1. **Transport failure or empty body** → sync error, stop (`:844-849`).
2. **No `percentage` in the body** → "No progress found for this document",
   stop (`:851-859`). This is how an unknown document is detected; see
   `[K-GET-3]`.
3. **Self-detection**: if `body.device == Device.model` *and*
   `body.device_id == self.device_id`, stop (`:861-870`). See the `[K-FLD-8]`
   caveat about custom device names.
4. **Already synchronised**: if the rounded remote percentage equals the local
   percentage, *or* `body.progress == progress`, stop (`:877-886`).
5. **Interactive pull** (the user pressed the button): apply the remote
   position unconditionally, no prompt (`:889-895`).
6. **Automatic pull**: decide direction, then consult the strategy settings.

**[K-SYNC-2]** The direction decision, verbatim (`main.lua:897-903`):

```lua
local self_older
if body.timestamp ~= nil then
    self_older = (body.timestamp > self.last_page_turn_timestamp)
else
    -- If we are working with an old sync server, we can only use the percentage field.
    self_older = (body.percentage > percentage)
end
```

- `body.timestamp` is the **server's** `os.time()` at the moment of the last
  write (§7.7).
- `self.last_page_turn_timestamp` is the **device's** `os.time()` at its own
  last page turn (`main.lua:982`), initialised to `0` at plugin init
  (`main.lua:88`).

**[K-SYNC-3] These are two clocks, compared directly.** There is no skew
allowance and no server-supplied "now". A device whose clock is behind the
server's treats every remote position as newer; a device ahead of the server
treats every remote position as older. Both are silent.

Because `last_page_turn_timestamp` starts at `0`, the **first** automatic pull
after opening a document always classifies the remote position as newer,
whatever it is.

**[K-SYNC-4]** Once the direction is known (`main.lua:904-932`):

| Direction | Setting | Default | Behaviour |
|---|---|---|---|
| remote is newer (`self_older == true`) | `sync_forward` | `PROMPT` | `SILENT` → jump; `PROMPT` → confirm box; `DISABLE` → nothing |
| remote is older | `sync_backward` | `DISABLE` | same three |

`SYNC_STRATEGY` = `{PROMPT = 1, SILENT = 2, DISABLE = 3}` (`main.lua:40-44`);
defaults at `main.lua:63-64`.

### 9.1 The consequence of omitting `timestamp`

**[K-SYNC-5]** A server that omits `timestamp` from `GET` forces the client
onto the fallback branch, where "newer" is redefined as "further through the
book".

That is not merely less accurate; it **inverts the default policy** in the one
case that matters. Consider a reader who finishes chapter 12 on device A, then
opens device B, which still holds a position at chapter 3, and reads on:

- **With `timestamp`:** B's newer write wins on A's next pull. Correct.
- **Without `timestamp`:** device B pulls A's position, sees
  `body.percentage > percentage`, and classifies it as *forward* — so B jumps
  ahead, discarding nothing but surprising the reader. Conversely, when the
  genuinely newest position is *earlier* in the book (re-reading, or a
  correction), it is classified as *backward*, and `sync_backward` defaults to
  `DISABLE`, so **the newest position is silently ignored**.

The comment in the client calls this "an old sync server". Every current server
should send `timestamp`. It is the reason `[K-FLD-13]` is a MUST.

### 9.2 Push side

**[K-SYNC-6]** The client debounces non-interactive pushes *and* pulls to one
per 25 seconds (`main.lua:52`: `API_CALL_DEBOUNCE_DELAY = time.s(25)`;
`:723`, `:821`). Servers should not expect a push per page turn.

**[K-SYNC-7]** Socket timeouts are tight and differ by operation
(`koreader plugins/kosync.koplugin/KOSyncClient.lua:5-8`):

```lua
-- Push/Pull
local PROGRESS_TIMEOUTS = { 2,  5 }
-- Login/Register
local AUTH_TIMEOUTS     = { 5, 10 }
```

Block (connect, read) in seconds. **A progress endpoint that takes more than
five seconds to answer is a failed request** from the client's point of view,
and will be retried from the queue (§6.4). Do no inline enrichment on the PUT
path.

---

## 10. Behaviours a reimplementer would otherwise have to guess

Collected in one place. Each is normative, each has a citation above.

| # | Behaviour | Why it is not guessable |
|---|---|---|
| 1 | **Unknown document → `200 {}`, never `404`.** `[K-GET-3]` | REST instinct says 404. The client reads field presence, not status, and renders a 404 as a sync *error*. |
| 2 | **`202` is declared but never emitted.** §5.4 | `api.json:44` lists it in `expected_status`. No server path produces it and the client treats it as failure. |
| 3 | **`metadata` is accepted and silently dropped by the reference server.** `[K-FLD-10]` | It is in `api.json` as an optional param, so it looks supported. It is not stored anywhere. |
| 4 | **`password` in `POST /users/create` is already an MD5.** `[K-REG-1]` | The field name says otherwise. Hashing it again produces unusable accounts. |
| 5 | **`x-auth-key` is opaque and case-sensitive.** `[K-AUTH-3]` | It looks like a hash to validate. The reference server compares raw bytes and imposes no shape. |
| 6 | **Registration-disabled is `402`, not `403`.** `[K-REG-5]` | 402 Payment Required is a bizarre choice; it exists because Spore raises on undeclared statuses and `api.json` declares only `[201, 402]`. |
| 7 | **`403` and `402` each cover two distinct conditions.** §6.3 | Only the numeric `code` disambiguates, and the reference client never reads it. |
| 8 | **`progress` is a string even for page numbers.** `[K-FLD-2]` | `"56"` looks like it wants to be an integer. Coercing it destroys EPUB XPointers. |
| 9 | **`timestamp` is server-generated, in seconds.** `[K-FLD-12]`, `[K-FLD-14]` | Nothing in `api.json` mentions it. Milliseconds break conflict resolution permanently. |
| 10 | **Omitting `timestamp` inverts the default sync policy.** §9.1 | The fallback path looks like a graceful degradation. It is not. |
| 11 | **The `Accept` header is load-bearing on the reference server.** `[K-ACC-2]` | It selects the API version. Omitting it yields `412`, not `406`, with a framework code in the 100s. |
| 12 | **Responses are `application/json`, not the vendor type.** `[K-CT-3]` | Symmetry suggests the vendor type. `gin` hardcodes `application/json`. |
| 13 | **Colons are forbidden in usernames and document ids.** `[K-AUTH-4]`, `[K-GET-1]` | It is a Redis key-injection guard, invisible to anyone not using Redis. |
| 14 | **A non-401 error causes the client to queue and retry for four weeks.** §6.4 | A permanent failure reported as 400 or 500 becomes a month-long retry loop. |
| 15 | **A PUT that takes >5 s has already failed.** `[K-SYNC-7]` | Nothing advertises the timeout. |
| 16 | **The server's README key layout is stale.** §14.1 | It describes flat per-field Redis keys; the code writes hashes. |

---

## 11. Divergence across implementations

Surveyed 2026-09-21. Every cell is a file-and-line citation into the named
repository at the commit given.

| Key | Implementation | Role | HEAD |
|---|---|---|---|
| **REF** | `koreader/koreader-sync-server` | server | `237ab22` (2026-09-10) |
| **KO** | `koreader/koreader` kosync plugin | client | `dcf6e3b` (2026-09-20) |
| **TSU** | `pid1/tsundoku` | server | working tree, 2026-09-21 |
| **XPT** | `crosspoint-reader/crosspoint-sync` | server | `e6852f7` (2026-09-19) |
| **CMO** | `Cmooon/kosync` (Codeberg, Gleam) | server | `dbd31fa` (2026-08-23) |
| **NPZ** | `nperez0111/koreader-sync` | server | `dab2629` (2026-09-16) |
| **DOT** | `jberlyn/kosync-dotnet` | server | `eec8d34` (2026-09-08) |
| **KAV** | `Kareadita/Kavita` (`develop`) | server | `aff9c74` (2026-09-20) |
| **CWA** | `crocodilestick/calibre-web-automated` | server **+ forked client** | `43718d8` (2026-08-06) |
| **RDS** | `readest/readest` | client | `4d9e4d5` (2026-09-21) |

### 11.1 Document hash

This is the table the brief asked for, and the one place where a silent,
undiagnosable failure is produced by an off-by-one.

| Impl | Implements partial MD5? | Samples | First offset | Reaches 1 GiB offset? | Hex case | Citation |
|---|---|---|---|---|---|---|
| KO | yes — the definition | **12** | **0** | yes | lower | `frontend/util.lua:1094-1112` |
| TSU | yes, plus the 256 variant | 12 / 12 | 0 / 256 | yes | lower | `src/books/partialmd5.ts:36-70` |
| **KAV** | yes | **11** ⚠ | 0 | **no** ⚠ | **UPPER** ⚠ | `Kavita.Services/Helpers/KoreaderHelper.cs:38-70` |
| CWA | yes | **12** | 0 | yes | lower | `cps/progress_syncing/checksums/koreader.py:69-107` |
| RDS | yes | **12** | 0 | yes | lower | `apps/readest-app/src/utils/md5.ts:11-30` |
| XPT | **no** — `document` opaque | — | — | — | — | `docs/API.md:42-44` |
| CMO | **no** — opaque | — | — | — | — | absent from `src/` |
| NPZ | **no** — opaque | — | — | — | — | absent from `src/index.tsx` |
| DOT | **no** — opaque `string documentHash` | — | — | — | — | absent from `Controllers/` |

**Kavita takes eleven samples, not twelve.** The loop bound is exclusive
(`Kavita.Services/Helpers/KoreaderHelper.cs:52`):

```csharp
        for (var i = -1; i < 10; i++)
        {
            file.Position = step << 2 * i;
```

`i` runs −1…9, so the offset `1073741824` is never sampled. The first offset is
0, for the same reason as in LuaJIT — C#'s `<<` masks the shift count to five
bits, `-2 & 31 == 30`, and `1024 << 30` overflows `int` to 0 — so Kavita agrees
with KOReader on **every file below 1 GiB** and disagrees on every file at or
above it. Since 1 GiB ebooks are rare, the divergence is close to invisible and
will not show up in testing.

Kavita also emits **uppercase** hex
(`KoreaderHelper.cs:69`: `Convert.ToHexString(md5.Hash).ToUpper()`), where
KOReader emits lowercase. It normalises on lookup
(`Kavita.Data/Repositories/MangaFileRepository.cs:31`:
`f.KoreaderHash.Equals(hash.ToUpper())`), so it interoperates — but the values
stored in its database are not the values KOReader computes, and its own pinned
test expects upper (`Kavita.Services.Tests/Helpers/KoreaderHelperTests.cs:165`).

**calibre-web-automated is the most faithful third-party reproduction**,
including an explicit reconstruction of the LuaJIT masking rather than a
happy accident (`cps/progress_syncing/checksums/koreader.py:80-85`):

```python
                shift_count = 2 * i
                masked_shift = shift_count & 0x1F  # LuaJIT: only lower 5 bits used

                # Perform the shift (may overflow to 0)
                result = step << masked_shift
                # Mask to 32-bit unsigned range like LuaJIT does
                position = result & 0xFFFFFFFF
```

…but **its own prose contradicts its code.** Both
`cps/progress_syncing/README.md:39` and the module docstring at
`checksums/koreader.py:39-41` claim *"11 positions (0, 4K, 16K, 64K, 256K, 1M,
4M, 16M, 64M, 256M, 1G)"* — dropping the 1 KiB sample and undercounting by one.
The code is right and both prose copies are wrong. Do not build a table from
that README.

**A server does not need the hash at all.** Four of the eight servers never
compute it and they interoperate fine, because kosync only requires that *a
user's own devices* agree on the string. A server needs the hash only to link a
synced position back to a book it also hosts.

### 11.2 Status code for registration-disabled

| Impl | Status | `code` | Citation |
|---|---|---|---|
| REF | **402** | **2005** | `config/errors.lua:22`, `syncs_controller.lua:131-133` |
| TSU | 403 | *(none)* | `src/routes/kosync.ts:48-56` |
| XPT | 403 | 2003 | `src/routes/kosync.ts:243-245` |
| CMO | *feature absent* | — | no registration toggle in `src/` |
| NPZ | 403 | *(none — `text/plain` body)* | `src/index.tsx:397-402` |
| DOT | 402 | *(none)* | `Controllers/SyncController.cs:86-93` |

**No implementation other than the reference emits 402/2005.** A client that
discriminates on it will misreport five of six servers.

Duplicate username is better behaved: REF, XPT and CMO all return 402/2002
(`syncs_controller.lua:121-125`; `crosspoint src/routes/kosync.ts:265-267`;
`Cmooon src/http/api_response.gleam:23-28`). DOT returns 402 with no code
(`SyncController.cs:98-105`); NPZ returns **409** with body key `error`
(`src/index.tsx:438-448`).

### 11.3 `Content-Type` matching strictness

| Impl | Requires `Accept` vendor type? | Request `Content-Type` gate | Response `Content-Type` | Citation |
|---|---|---|---|---|
| REF | **yes — 412/100 if absent** | **none** | `application/json` | `gin gin/core/router.lua:53`, `:88-94`; `gin/core/request.lua:17-29` |
| TSU | no | none | `application/vnd.koreader.v1+json` | [measured] §5.1 |
| XPT | no (accepted, never required) | none (`c.req.json()`) | `application/json` | `docs/API.md:11-12` |
| CMO | no | **strict `application/json`** | `application/json; charset=utf-8` | `src/handler/sync.gleam:11` (`wisp.require_json`); type pinned in `test/endpoint/healthcheck_test.gleam:12-13` |
| NPZ | no | none | `application/json`; **errors are `text/plain`** | `src/index.tsx:466`; Hono `HTTPException` |
| DOT | no | framework: 415 on mismatch, but `application/*+json` matches | `application/json; charset=utf-8`, except `application/json` on GET progress | `Controllers/SyncController.cs:5` (`[ApiController]`), `:243-248` |

Two opposite traps sit in this table. **REF is the only implementation that
requires `Accept`**, so a client tested only against a third-party server may
omit it and fail against the official one. **CMO is the only implementation
that requires a request `Content-Type`**, and its own README records the
consequence (`Cmooon README.md:25-29`): a third-party client that sent no
`Content-Type` was rejected until it was fixed.

### 11.4 Unknown document

| Impl | Answer | Citation |
|---|---|---|
| REF | `200 {}` | `spec/controllers/1/syncs_controller_spec.lua`, *"cannot get progress of non-existent document"* |
| TSU | `200 {}` | [measured] §5.5 |
| XPT | `200 {}` | `src/routes/kosync.ts:340-343` |
| CMO | `200 {}` | `src/handler/sync.gleam:47-51` |
| NPZ | **`404 {"status":"not found"}`** | `src/index.tsx:596-599` |
| DOT | **`502 {"message":"Document not found on server"}`** | `Controllers/SyncController.cs:218-225` |

### 11.5 `PUT /syncs/progress` response shape

| Impl | Body | `timestamp` type | Citation |
|---|---|---|---|
| REF | `{document, timestamp}` | integer seconds | `syncs_controller.lua:267-270` |
| TSU | `{document, timestamp}` | integer seconds | [measured] §5.4 |
| XPT | `{document, timestamp}` | integer seconds | `src/routes/kosync.ts:309` |
| CMO | `{document, timestamp}` | integer seconds | `src/handler/sync.gleam:26-31` |
| NPZ | **`{status:"success"}` — no `timestamp`, no `document`** | — | `src/index.tsx:557` |
| DOT | `{document, timestamp}` but **ISO-8601 string on PUT and integer seconds on GET** | mixed | `Controllers/SyncController.cs:175-179` vs `:229,:238` |

### 11.6 Required fields on PUT

| Impl | `document` | `progress` | `percentage` | `device` | `device_id` |
|---|---|---|---|---|---|
| REF | required | required | required (numeric) | required | optional |
| TSU | required | optional | optional | optional | optional |
| XPT | required | required | required, **range-checked [0,1]** | optional | optional, **falls back to `device`** |
| CMO | required | required | required | required | optional (NULL) |
| NPZ | required | required (truthy) | required | required (truthy) | **required — 400 if absent** |
| DOT | required | required | **omitted ⇒ silently `0`** | required | **required — 400 if absent** |

Citations: `syncs_controller.lua:242-259`; tsundoku `src/routes/kosync.ts:75-97`
[measured, §14.2]; `crosspoint src/routes/kosync.ts:205-216`;
`Cmooon src/domain/progress.gleam:17-28`; `nperez0111 src/index.tsx:486-498`;
`kosync-dotnet Models/DocumentRequest.cs:3-14`.

**DOT's asymmetry is the sharpest trap in this table.** `percentage` is a
non-nullable `decimal`, a C# value type, so ASP.NET's implicit-required rule
does not apply to it: an omitted `percentage` binds to `0` and is stored,
erasing the reader's position, while an omitted `device_id` hard-fails with
400.

### 11.7 `metadata`

| Impl | Behaviour | Citation |
|---|---|---|
| REF | accepted, **silently dropped** | absent from `syncs_controller.lua` |
| TSU | accepted and stored (JSON, truncated to 4000 chars) | `src/routes/kosync.ts:84-88` |
| XPT | stored, with `COALESCE` so omission never clobbers; harvests `<service>_id` keys as external ids | `src/routes/kosync.ts:57-95` |
| CMO | silently dropped (decoder has no such field) | `src/domain/progress.gleam:16-36` |
| NPZ | stores `filename`/`title`/`authors` with `COALESCE` | `src/index.tsx:501-503`, `:526-528` |
| DOT | silently dropped | `Models/DocumentRequest.cs:3-14` |

### 11.8 Numeric `code` in error bodies

| Impl | Emits `code`? | Codes used |
|---|---|---|
| REF | yes | 1000, 2000–2006, 100–104 |
| TSU | **no** — `{message}` only | — |
| XPT | yes | 2001–2004 (2001 also on 429) |
| CMO | yes | 2001–2004 |
| NPZ | **no** — `text/plain` or `{error}` | — |
| DOT | **no** — `{message}` only | — |

**Codes 2005 and 2006 are emitted by no implementation except the reference.**

### 11.9 `x-auth-key` treatment

| Impl | Stored as | Consequence |
|---|---|---|
| REF | verbatim | a database is portable to any other verbatim implementation |
| TSU | HMAC-SHA256 under a server pepper, key **lowercased first** (`src/auth/password.ts:55-57`) | tolerant of hex case; not portable |
| XPT | PBKDF2-SHA256 ×10000, with an MD5 re-hash fallback for clients that send the raw password (`src/auth/middleware.ts:57-63`) | not portable |
| CMO | Argon2id over the received string (`src/repo/user_repo.gleam:18-21`) | not portable; hex case is account-breaking |
| NPZ | Argon2 over `key + static salt` (`src/index.tsx:325-326`, salt default at `:75`) | not portable; changing `PASSWORD_SALT` invalidates all accounts |
| DOT | verbatim equality (`Services/UserService.cs:64-70`) | portable |

Hardening the stored credential is a defensible choice and changes nothing on
the wire. Note only that it makes migration from the reference server
impossible, since the reference stores the MD5 itself and cannot produce
plaintext.

### 11.10 Endpoint coverage

| Impl | `/healthcheck` | `/users/create` | `/users/auth` | `PUT /syncs/progress` | `GET /syncs/progress/:d` | `DELETE /users/me` | `PUT /users/password` |
|---|---|---|---|---|---|---|---|
| REF | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| TSU | ✅ | ✅ (403) | ✅ | ✅ | ✅ | ✗ (405) | ✗ (405) |
| XPT | ✗ (`/healthz`) | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ |
| CMO | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ |
| NPZ | ✗ (`/health`) | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ |
| DOT | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ (`/manage/users`) | ✗ (`/manage/users/password`) |

DOT's `GET /users/auth` also returns the wrong body — `{username: …}` rather
than `{"authorized":"OK"}` (`Controllers/SyncController.cs:77-80`).

---

## 12. Conformance

### 12.1 The verifier

[`verify.mjs`](verify.mjs), in this repository, checks a running server against
the requirement identifiers above. It has no runtime dependencies beyond
Node 18+, takes a base URL and credentials, and reports pass/fail per
requirement with the spec section cited.

```bash
node verify.mjs --base-url https://sync.example.com \
  --user alice --password hunter2 --json report.json
```

Full options, profile flags and the recipe for standing up the reference
server are in [`README.md`](README.md) and
[`reference-server/`](reference-server/).

The `[K-ID-…]` requirements of §5.8 do not decide that verdict. They describe an
unmerged proposal and are `MAY`, under the optional feature `identifiers`
(§12.5): a server that does not implement them skips them and stays conformant,
and a server that does is held to all of them.

### 12.2 Checklist for a new server

Work down this list; each row names the requirement it satisfies.

**Transport**

- [ ] Serve over TLS. `[K-URL-2]`
- [ ] Route the five client-facing paths exactly as in §3.2. `[K-URL-1]`
- [ ] Accept requests with or without `Accept: application/vnd.koreader.v1+json`. `[K-ACC-3]`
- [ ] Do **not** gate on request `Content-Type`. `[K-CT-2]`
- [ ] Return a JSON media type on every response. `[K-CT-3]`
- [ ] Accept a JSON object body; reject arrays. `[K-BODY-1]`

**Authentication**

- [ ] Read `x-auth-user` and `x-auth-key`, case-insensitively as HTTP requires. `[K-AUTH-1]`
- [ ] Treat `x-auth-key` as an opaque credential; do not require 32 hex chars. `[K-AUTH-3]`, `[K-AUTH-5]`
- [ ] Reject usernames containing `:` or empty. `[K-AUTH-4]`
- [ ] Answer 401 for missing headers, unknown user and wrong key alike. `[K-AUTH-6]`
- [ ] `GET /users/auth` → `200 {"authorized":"OK"}`. `[K-AUTH-7]`

**Registration**

- [ ] Treat `password` as already-hashed. `[K-REG-1]`
- [ ] 201 `{"username":…}` on success. `[K-REG-2]`
- [ ] 402 / 2002 when taken. `[K-REG-3]`
- [ ] 403 / 2003 on invalid fields. `[K-REG-4]`
- [ ] 402 / 2005 when registration is off. `[K-REG-5]`

**Progress**

- [ ] `PUT` requires `document`, `progress`, `percentage`, `device`. `[K-PUT-1]`, `[K-PUT-2]`
- [ ] `PUT` returns `{document, timestamp}` and nothing else. `[K-PUT-3]`
- [ ] `timestamp` is server-generated Unix **seconds**. `[K-PUT-4]`, `[K-FLD-14]`
- [ ] Last write wins, unconditionally. `[K-PUT-5]`
- [ ] Store and return `progress` as a string, byte-for-byte. `[K-FLD-3]`
- [ ] `GET` on a known document returns `document`, `percentage`, `progress`, `device`, `timestamp`, and `device_id` if stored. `[K-GET-2]`
- [ ] **`GET` on an unknown document returns `200` with `{}`.** `[K-GET-3]`
- [ ] `GET` always includes `timestamp`. `[K-FLD-13]`
- [ ] Accept `metadata` without failing; do not clear it when omitted. `[K-FLD-10]`, `[K-FLD-11]`
- [ ] Answer within 5 seconds. `[K-SYNC-7]`
- [ ] Never emit `202`. §5.4

**Errors**

- [ ] Error bodies are `{"code": …, "message": …}`. `[K-ERR-1]`
- [ ] Use the code table in §6.1 verbatim.
- [ ] Use **401** for every permanent authentication failure, so the client stops retrying. §6.4

**Isolation**

- [ ] A document stored for one user is invisible to another. `[K-ISO-1]`

### 12.3 Requirement coverage

Every requirement identifier defined in this document is either asserted by
`verify.mjs` or listed in §12.4 with a reason. That claim is **checked
mechanically**, not by hand:

```bash
node coverage.mjs          # non-zero exit if spec and verifier have drifted
node coverage.mjs --list   # the full per-requirement mapping
```

It fails if a requirement is defined here with neither an assertion nor a §12.4
row, and it fails if `verify.mjs` asserts an identifier this document does not
define. It runs in CI.

Requirements defined in a section whose heading says **proposed** are counted
separately, and `coverage.mjs` additionally fails if one of them belongs to no
optional feature. `verify.mjs` refuses at run time to record a requirement under
a feature's prefix without naming that feature, so a proposed requirement cannot
reach `MUST` and be charged to every server.

### 12.4 Requirements the verifier cannot check

| Requirement | Why not |
|---|---|
| `[K-URL-2]` TLS | The verifier reports the scheme of the URL it was given, as `INFO`, but cannot audit a deployment it is not pointed at. |
| `[K-URL-1]` unversioned paths | True by construction: every other assertion is issued against exactly these paths, so the suite could not pass if they were versioned. |
| `[K-AUTH-1]` credentials in `x-auth-user`/`x-auth-key` | Same: every authenticated assertion sends only these two headers. A server reading credentials elsewhere fails all of them. |
| `[K-AUTH-2]` the key is `md5(password)` | Client-side. Checkable only by inspecting a client. The verifier computes the MD5 itself and so exercises the server's half. |
| `[K-CT-1]` clients send valid JSON | Client-side. |
| `[K-CT-4]` clients must not dispatch on response `Content-Type` | Client-side. The server half is `[K-CT-3]`, which is asserted. |
| `[K-REG-1]` `password` is pre-hashed | Not directly observable: a correct server and a double-hashing server both accept the registration. The verifier asserts the consequence instead — register with key `K`, then authenticate with key `K` — which a double-hashing server fails. |
| `[K-PUT-6]` atomic re-authorisation | Needs a race between a write and an account deletion that the verifier cannot reliably create. |
| `[K-GET-1]` document-id character set | Not assertable as a rule, because the reference server's write and read paths disagree about it (§14.3). The verifier asserts the observable consequence as `[K-DOC-ID-1]` and records the charset as `[K-DOC-ID-2]`. |
| `[K-DEL-1]`, `[K-DEL-2]`, `[K-DEL-3]` deletion behaviour | `DELETE /users/me` is optional, unimplemented by every surveyed server but the reference, and probing it would delete the account under test. Reported as `INFO` only. |
| `[K-PWD-2]` a password change preserves progress | `PUT /users/password` is optional, and asserting this means changing the credential mid-run, after which every later assertion would need the new key. |
| `[K-FLD-2]` `progress` is a string on the wire | Client-side. The server half — that it round-trips byte-for-byte — is `[K-FLD-3]`, which is asserted. |
| `[K-FLD-5]` the reference does not range-check `percentage` | A statement about what the reference does *not* do. A server that clamps is safer, not less conformant, so there is nothing to fail. `[K-FLD-4]` asserts the round trip instead. |
| `[K-FLD-9]` the shape of `metadata` | Client-side. The server half is `[K-FLD-10]` and `[K-FLD-11]`, both asserted. |
| `[K-FLD-12]` `timestamp` is epoch seconds | Asserted as `[K-FLD-14]`, which checks the value is within a day of now and so would catch milliseconds. |
| `[K-FLD-8]` device self-detection | Client-side. The server precondition — that `device_id` round-trips — is `[K-FLD-7]`. |
| `[K-SYNC-1]` … `[K-SYNC-6]` conflict resolution | Entirely client-side; the server never compares anything. The verifier asserts the server-side preconditions instead: `timestamp` present (`[K-FLD-13]`), in seconds (`[K-FLD-14]`), server-generated (`[K-PUT-4]`), and last-write-wins (`[K-PUT-5]`). |
| `[K-ID-12]` an alias is created, never repointed | Not observable over HTTP: the alias table is private, and every wire consequence of it is already asserted — resolution is stable (`[K-ID-4]`), a document that exists in its own right is never shadowed (`[K-ID-7]`), and an identifier above the match is never registered (`[K-ID-12b]`). Proposed; see §5.8. |
| `[K-ID-5b]` identifiers are ordered strongest first | Client-side, and not inferable from the wire: the server has no idea what any type means, so a weakest-first list is indistinguishable from a strongest-first one whose strongest identifier happens to be the one that matched. Checkable only by inspecting a client. Proposed; see §5.8. |
| `[K-ID-15]` a client offers only the types it can compute honestly | Client-side, and invisible from the server: a list of two is indistinguishable from a client that could only manage two, and a value that merely resembles a registered type is a correct-looking string the server has no way to judge. Checkable only by inspecting a client. Proposed; see §5.8. |
| `[K-ID-14]` a client must not follow a position on an unrecognised `progress_match` | Client-side. The server reports the type and acts on it in no way, so nothing over the wire distinguishes a client that honours this from one that ignores it. Checkable only by inspecting a client. Proposed; see §5.8. |
| `[K-ID-13]` aliases are removed with the account | Same reason as `[K-DEL-1]`: probing `DELETE /users/me` would delete the account under test. Proposed; see §5.8. |
| `[K-DOC-1]` … `[K-DOC-10]` document identity | Not a server behaviour: `document` is opaque to a server, and four of the eight surveyed servers never compute it (§11.1). Checked by `vectors/check.mjs` against the golden vectors of §8.6, not over HTTP. |


### 12.5 Optional features

An optional feature groups the `MAY` requirements of one capability. The
verifier probes for each feature once, before the suites run, and prints what it
found:

```
Optional features
  no   [<key>] <what the feature is>
         SPEC.md <section>
```

A feature the server does not implement has every one of its requirements
recorded as `SKIP`. A feature it does implement is checked in full, and a
failure there is reported without changing the exit status, because conformance
is decided by `MUST` alone.

Detection is a probe, not a command-line flag. A server that has to be described
to the verifier in order to be scored correctly will sooner or later be
described wrongly, and the resulting failures say nothing about the server.

The JSON report carries each outcome under `features`, so CI can gate on whether
a capability is present as well as on whether it is correct:

```json
"features": { "<key>": { "present": false, "section": "<section>", "note": null } }
```

---

## 13. Reproduction

### 13.1 LuaJIT shift semantics

```lua
-- offsets.lua
local bit = require("bit")
local lshift = bit.lshift
local step = 1024
for i = -1, 10 do
  print(i, 2*i, lshift(step, 2*i), 1024 * (4 ^ i))
end
```

```
$ luajit offsets.lua
```

Produces the table in §8.4. Verified with LuaJIT 2.1.1788856981.

### 13.2 Golden vectors

The sampler is a verbatim transcription of `util.partialMD5` with
`update(sample)` replaced by a write to stdout, so the digest can be taken by
an external MD5 rather than by a Lua one:

```lua
-- samples.lua  <path>
local bit = require("bit")
local lshift = bit.lshift
local step, size = 1024, 1024
local file = assert(io.open(arg[1], "rb"))
for i = -1, 10 do
    file:seek("set", lshift(step, 2*i))
    local sample = file:read(size)
    if sample then io.stdout:write(sample) else break end
end
file:close()
```

```
$ luajit samples.lua leaves.epub | md5 -q
59d481d168cca6267322f150c5f6a2a3
```

The synthetic files of §8.6:

```js
// gen.mjs <dir>
import { openSync, writeSync, ftruncateSync, closeSync } from "node:fs";
const dir = process.argv[2];
const pattern = (n) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 0xff;
  return b;
};
for (const n of [500, 1024, 1025, 2048, 3000, 200000, 1050000]) {
  const fd = openSync(`${dir}/pattern-${n}.bin`, "w");
  writeSync(fd, pattern(n));
  closeSync(fd);
}
const OFFSETS = [0, 1024, 4096, 16384, 65536, 262144,
                 1048576, 4194304, 16777216, 67108864, 268435456, 1073741824];
const fd = openSync(`${dir}/sparse-1gib.bin`, "w");
ftruncateSync(fd, 1073741824 + 1024);
for (const o of OFFSETS) {
  writeSync(fd, Buffer.from(String(o).padStart(16, "0"), "ascii"), 0, 16, o);
}
closeSync(fd);
```

---

## 14. Errata in the reference sources

### 14.1 The server README's Redis key layout is stale

`koreader-sync-server README.md:104-113` documents progress storage as flat
per-field keys:

```
"user:chrox:document:0b229176d4e8db7f6d2b5a4952368d7a:percentage"  --> "0.31879884821061"
"user:chrox:document:0b229176d4e8db7f6d2b5a4952368d7a:progress"    --> "/body/DocFragment[20]/body/p[22]/img.0"
"user:chrox:document:0b229176d4e8db7f6d2b5a4952368d7a:device"      --> "PocketBook"
```

**The code does not do this.** It writes one Redis **hash** per document, keyed
`user:<username>:document:<document>`, with `percentage`, `progress`, `device`,
`device_id` and `timestamp` as *fields*
(`app/controllers/1/syncs_controller.lua:5-10`):

```lua
    doc_key = "user:%s:document:%s",
    progress_field = "progress",
    percentage_field = "percentage",
    device_field = "device",
    device_id_field = "device_id",
    timestamp_field = "timestamp",
```

written with `HSET` (`:60`, inside `update_progress_script`) and read with
`HMGET` (`:195-200`). **The code is right and the README is stale.** The README
also predates the `timestamp` and `device_id` fields, which it does not mention
at all.

The account key is documented correctly: `user:<username>:key` →
the client-supplied MD5 (`README.md:110-114`, `syncs_controller.lua:4`).

This matters for operators reading the README to write a migration or a backup
script: a `KEYS user:*:document:*:percentage` sweep returns nothing.

### 14.2 `api.json`'s `expected_status` is not a server contract

`api.json` declares `202` for `update_progress` (§5.4) and lists `device_id`
among `required_params` for a field the server treats as optional (§5.4).
`required_params` is a Spore client-side assertion about what the *caller* must
pass to the Lua method; it says nothing about what the server enforces. Read
the controller, not the descriptor.

### 14.3 `PUT` accepts document ids that `GET` cannot serve

Described in full at `[K-GET-1a]` (§5.5), and reproduced against a running
`koreader/kosync:latest` on 2026-09-21. In short: the write path validates
`document` in the controller, where only a colon is forbidden; the read path
validates it in the router, where only `[A-Za-z0-9_]` is permitted
(`gin gin/core/routes.lua:44`). Any id with a hyphen or a dot is therefore
stored and then unreachable, and the read fails with a bare nginx HTML 404
rather than any protocol-level error.

The conformance verifier records this as a `SHOULD`, not a `MUST`, precisely
because the reference implementation fails it: a requirement derived from the
reference cannot be one the reference violates. It is listed as a defect to be
avoided by new servers, not as a rule already in force.

### 14.4 Error code 2004's message

`Field 'document' not provided.` is raised both when the field is missing from
a PUT body *and* when the `:document` path segment of a GET is invalid
(`syncs_controller.lua:188-191`). In the second case nothing was "provided" or
not; the message is misleading. The controller's own source carries a comment
questioning the code's existence (`syncs_controller.lua:17`):

```lua
    -- Do we really need to handle 'document' field specifically?
```

---

## 15. Open questions

| Question | Status |
|---|---|
| What does the **official hosted server** at `sync.koreader.rocks` actually do? | **[unverified]** — it did not respond within 8 s on 2026-09-21. Everything here describes the published server source, which may differ from what is deployed. |
| Does a given KOReader **build** write the offset-0 digest to its sidecar? | **[unverified]** — §8.7. The algorithm is proven against KOReader's own test suite; a specific binary has not been observed. |
| Is there any client that sends a `timestamp` on PUT? | Not among those surveyed. The reference server would ignore it. |
| Is `202` reachable on any server? | Not among those surveyed. |
| Is error code `100` reachable? | **No**, in practice — §3.3. Every HTTP client sends a default `Accept`, so the reference server answers `101`. |
| Will `identifiers` (§5.8) be merged, and in this shape? | **Open.** `koreader/koreader-sync-server#55` is unmerged as of 2026-09-22. §5.8 is pinned to a branch commit for that reason. |
| What identifier **types** should a client send? | `content`, `structure` and `filename`, with the recipes in the §5.8 registry. The server still treats `type` as an opaque label and never interprets it (`identifiers.lua:1-3`), so the set can grow without a server change — but `progress_match` makes the label a trust signal between clients, so a label without a recipe is not interoperable (`[K-ID-14]`). None of the three is computed by any released KOReader build. |
| How should a client pick the `document` when it holds several identifiers? | **Open.** §5.8 requires only that the first entry equal `document`. Which identifier that ought to be is a client decision no implementation has yet made. |
| Does an alias ever expire? | **No, in the proposal.** Aliases are removed only with the account (`[K-ID-13]`). A long-lived account accumulates one alias per distinct identifier it has ever offered, and nothing in the branch bounds that. |
| Does the official deployment carry the `[K-GET-1a]` router defect? | **[unverified]** — the published image does (measured). Whether `sync.koreader.rocks` runs that image is unknown. |

---

## 16. Licence and provenance of quotations

This document is released under CC0-1.0 (see `LICENSE-SPEC`), so that any
implementation may copy from it without attribution obligations. The verifier
alongside it is BSD-3-Clause (see `LICENSE`), except `vectors/samples.lua`, which is a
transcription of AGPL-3.0 code and is AGPL-3.0-or-later (see `LICENSE-SAMPLES`).

Code quoted from `koreader/koreader` is AGPL-3.0. Code quoted from
`koreader/koreader-sync-server` is AGPL-3.0 (`COPYING`). Code quoted from
`ostinelli/gin` is MIT. Quotations are short excerpts for the purpose of
description and carry their original licences.

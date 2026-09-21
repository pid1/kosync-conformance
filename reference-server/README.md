# Running the reference kosync server locally

`koreader/koreader-sync-server` is Lua on OpenResty with Redis. There is no
written guide to running it outside Docker, and the Docker path has a couple of
sharp edges. This is the recipe that worked on 2026-09-21, written down because
the verifier's results are only meaningful if you can reproduce the thing it is
measured against.

## The short version

```bash
./run.sh          # starts it on http://127.0.0.1:8080
./run.sh stop
```

Then:

```bash
node ../verify.mjs --base-url http://127.0.0.1:8080 \
  --user refuser1 --password refpass1 --register --strict-accept
```

## What the image gives you

`docker.io/koreader/kosync:latest` runs `runsvdir` with two services, Redis and
the app, and exposes:

| Port | Protocol | Notes |
|---|---|---|
| `7200` | HTTPS | self-signed certificate generated at image build time |
| `17200` | HTTP | for use behind a TLS-terminating proxy |

Map **17200** unless you are specifically testing TLS. A self-signed
certificate makes Node's `fetch` fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
and the workaround (`NODE_TLS_REJECT_UNAUTHORIZED=0`) disables verification
process-wide.

The image sets `ENABLE_USER_REGISTRATION=true` and `GIN_ENV=production` in its
`Dockerfile`, so registration is open and Redis database **1** is in use.

Verified on 2026-09-21: image `db2a16684d0b`, `linux/arm64`, OpenResty
1.29.2.3, `X-Framework: gin/0.2.0`.

## Podman instead of Docker

The image is multi-arch and runs unmodified under Podman, which needs no
background daemon on macOS beyond its own VM:

```bash
podman machine init      # once; harmless "already exists" if you have one
podman machine start
podman run -d --name kosync-ref -p 8080:17200 -p 8443:7200 \
  docker.io/koreader/kosync:latest
```

To reset state between runs, flush the database rather than recreating the
container:

```bash
podman exec kosync-ref redis-cli -n 1 flushdb
```

## Without containers, on macOS

Possible in principle, and it is where most of a day can go. Recording what was
learned so nobody repeats it.

**OpenResty's Homebrew formula does not build on current macOS.** It passes
`--with-http_geoip_module`, and the `geoip` formula it depends on was removed
from homebrew-core, so `./configure` fails:

```
./configure: error: the GeoIP module requires the GeoIP library.
```

**Building OpenResty from source works** — the default configure does not
enable GeoIP:

```bash
brew install openresty-openssl3 pcre2 redis
curl -fsSLO https://openresty.org/download/openresty-1.31.1.1.tar.gz
tar xzf openresty-1.31.1.1.tar.gz && cd openresty-1.31.1.1
./configure --prefix="$PWD/../openresty" \
  --with-cc-opt="-I/opt/homebrew/include -I/opt/homebrew/opt/openresty-openssl3/include" \
  --with-ld-opt="-L/opt/homebrew/lib -L/opt/homebrew/opt/openresty-openssl3/lib" -j8
make -j8 && make install
```

**…but the resulting binary segfaulted on this machine** (macOS 26, arm64):
every worker died with `signal 11` at startup, including with a configuration
containing no Lua at all —

```nginx
server { listen 8080; location / { return 200 "plain-ok\n"; } }
```

— so the crash is in the built nginx, not in the Lua application.
`nginx -t` reported the configuration valid; running it exited 139. The link
step had warned:

```
ld: warning: building for macOS-26.0, but linking with dylib
    '.../libluajit-5.1.2.dylib' which was built for newer version 26.7
```

This was not chased further, because the container path works. **If you get
that binary running, the configuration below is what the app needs**, and it
has not been executed end to end — treat it as a starting point, not a
verified recipe.

`gin` is from 2015 and pins old dependencies; do **not** `luarocks make` it. It
is pure Lua, so putting it on `lua_package_path` is enough:

```bash
git clone --depth 1 https://github.com/koreader/koreader-sync-server.git
git clone --depth 1 https://github.com/ostinelli/gin.git
```

The app's `config/nginx.conf` is a template with `{{GIN_INIT}}` and
`{{GIN_RUNTIME}}` placeholders that gin's launcher substitutes
(`gin/cli/launcher.lua:49-52` and `:87-91`). Expanded by hand:

```nginx
worker_processes 1;
daemon off;
env ENABLE_USER_REGISTRATION;
env GIN_ENV;
events { worker_connections 1024; }
http {
  lua_code_cache on;
  lua_package_path  "<sync-server>/?.lua;<gin>/?.lua;<openresty>/lualib/?.lua;<openresty>/lualib/?/init.lua;;";
  lua_package_cpath "<openresty>/lualib/?.so;;";
  server {
    listen 8080;
    location / {
      content_by_lua 'require("gin.core.router").handler(ngx)';
    }
  }
}
```

Two things that are easy to get wrong:

- **nginx's working directory must be the sync-server checkout.**
  `gin/core/router.lua:1` prepends `./app/controllers/?.lua` to `package.path`,
  and `config.routes` is resolved relative to the prefix. Use
  `nginx -p <sync-server>`.
- **`GIN_ENV` selects the Redis database, not the port.** `development` uses
  database 3, `test` 2, `production` 1
  (`koreader-sync-server db/redis.lua:5-25`). The port comes from your `listen`
  directive; `config/settings.lua`'s port is only read by gin's own launcher.
  `db/redis.lua` hardcodes `127.0.0.1:6379`, so running Redis elsewhere means
  editing that file.

## A note on `--strict-accept`

The reference server **requires** `Accept: application/vnd.koreader.v1+json`
and uses it to select the API version. Run the verifier with `--strict-accept`
against it, or the relaxed-Accept check will be reported as a deviation when it
is actually correct behaviour. See SPEC.md §3.3.

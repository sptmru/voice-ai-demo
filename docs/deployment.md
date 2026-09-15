# Running and presenting Relay

## Local development

Use the README commands. Keep API and web ports on `3101` and `3100`, PostgreSQL on `55432`. The web origin must match `WEB_ORIGIN` exactly; the default is `http://localhost:3100`, so use that URL rather than switching to `127.0.0.1` in the browser. A comma-separated origin list is supported when needed. HTTP, SSE and voice WebSocket requests use the page's origin; Next.js proxies `/api/*` to the API, preserving the host-scoped HttpOnly ownership cookie.

On a remote development host use SSH forwarding:

```sh
ssh -L 3100:127.0.0.1:3100 your-dev-host
```

Then open `http://localhost:3100` locally. Browsers allow microphone capture on localhost; public hostnames need HTTPS.

## Database configuration

Set these once in `.env`:

```dotenv
POSTGRES_USER=relay
POSTGRES_PASSWORD='your-password'
POSTGRES_DB=relay
DB_HOST=127.0.0.1
DB_PORT=55432
```

Compose automatically reads `.env`. Its database service requires a nonempty `POSTGRES_PASSWORD`; no password is embedded in either Compose file. API, migrations, seed and integration tests build their connection URL from the same values, encoding reserved characters. Single-quote passwords containing `$` or `#` to preserve them in Compose. Do not use `${POSTGRES_PASSWORD}` inside `DATABASE_URL`: Node's env-file loader does not expand that syntax. An explicit `DATABASE_URL` remains available for an external database in host processes. Compose overrides it with an empty value and selects the local database through `DB_HOST=db`, `DB_PORT=5432`.

For a fresh database, choose the password before the first `docker compose up`. For an existing volume, changing `.env` alone **does not change the stored role password** ([Postgres image documentation](https://github.com/docker-library/docs/blob/master/postgres/content.md)). To rotate it without deleting data, open `docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, use interactive `\password`, enter the new password, then put the same value in `.env` and restart the API/recreate Compose services. Do not remove the database volume to apply a password change.

## Cloudflare Tunnel

A **named tunnel with a stable hostname** can route the whole app to `http://127.0.0.1:3100` when `cloudflared` runs on this host. Next.js forwards `/api/*`, including WebSocket upgrades and SSE, to port 3101. No public API port or second hostname is needed. When `cloudflared` runs as a container on the Compose network, the service URL is `http://web:3100`; `localhost` inside that container is not the host.

For example, create a published application route for `relay.example.com` → `http://127.0.0.1:3100`. Set:

```dotenv
WEB_ORIGIN=https://relay.example.com
COOKIE_SECURE=true
# Leave VOICE_PUBLIC_URL unset: the browser uses wss://relay.example.com automatically.
```

Replace the example hostname with yours and restart the API. If using Compose, recreate it with `docker compose -f compose.yaml -f compose.app.yaml up -d api web` after rebuilding when code changed. Prefer the production web build for a shared demo. TLS terminates at Cloudflare, so the local service URL remains HTTP. Add Cloudflare Access for the intended audience; the browser ownership cookie is session isolation, not login.

Optional locally managed configuration is in [infra/cloudflared.yml.example](../infra/cloudflared.yml.example). A direct routing alternative is to send `^/api(/.*)?$` to 3101 and all other paths to 3100, under the same hostname. Cloudflare evaluates ingress rules in order, and the final rule must be a catch-all ([routing configuration](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)).

Avoid `cloudflared tunnel --url ...` Quick Tunnels for this app: they **do not support SSE**, which drives the live dashboard ([Cloudflare limitation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). Local HTTP/SSE/WebSocket proxy checks do not prove an external Cloudflare deployment; after publishing, verify `/api/health`, live timeline updates and microphone connection on the HTTPS hostname.

## Optional Docker app

The default `compose.yaml` only starts PostgreSQL. To run the complete application in containers, stop the development processes using those same ports, then:

```sh
cp .env.example .env # only if .env does not already exist
docker compose -f compose.yaml -f compose.app.yaml build api
docker compose -f compose.yaml -f compose.app.yaml up -d db
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm db:migrate
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm db:seed
docker compose -f compose.yaml -f compose.app.yaml up -d api web
```

The image runs as the `node` user. ONNX uses CPU inference and skips CUDA downloads. Model weights live in a named volume and survive app replacement. Migrations and seed are explicit operations; app startup does not overwrite data. The same image runs API and web processes; these are parts of one application, not independent business microservices.

Next.js compiles its API rewrite during build. The Docker build defaults `API_INTERNAL_URL` to `http://api:3101`, matching the Compose service name. Override the Docker build argument if your API has a different internal address; changing only the web container's runtime variable is insufficient.

## Private hosted demonstration

Use a small Linux host with Docker and sufficient RAM for Node, Next.js and local embeddings (start with 2–4 GB). Install a TLS reverse proxy and an access gate for your demo audience. This repository does not provision hosting or expose a public site.

Set server environment:

```dotenv
WEB_ORIGIN=https://relay.example.com
VOICE_PUBLIC_URL=wss://relay.example.com
COOKIE_SECURE=true
VOICE_PROVIDER=gemini
```

Add the chosen provider key privately. Never put it in a `NEXT_PUBLIC_*` variable. Proxy `/api/` including WebSocket upgrades and SSE directly to API `3101`; proxy the rest to Next `3100`. See `infra/nginx.conf.example`. Configure matching hostnames so browser cookies reach both HTTP and voice routes. Gemini PCM travels through your server; OpenAI media travels directly from browser to OpenAI, with a trusted backend sideband for tools.

Demo identity maps all browser sessions to fictional Acme Ltd. Separate browsers cannot open each other's session endpoints. The knowledge base and customer memory are shared demo data, not a private multi-tenant document service. Add real authentication and tenant ownership before using private customer documents or production telecom systems. No API route invokes external email, carrier resets, real callbacks or paging.

## Data and recovery

- PostgreSQL is the source of truth. Back up the `relay_pg` volume or use `pg_dump` before changing the schema.
- Seed refreshes scenario templates and built-in knowledge idempotently; existing support sessions retain their snapshot. **Reset session** creates a fresh scenario and keeps history.
- SSE reconnect replays persisted events using a cursor; it does not rerun tools.
- Voice reconnect creates a fresh provider connection with a bounded application context. It does not claim provider-side session resumption or retry uncertain writes.
- A sensitive confirmation is consumed once. Approval is authorization, not execution success; inspect its completed/failed tool event. A failed or interrupted action must be reviewed before a fresh proposal.
- The Gemini default model was tested during implementation, but provider models and account quotas may change. Model IDs are configurable. OpenAI requires its own account access and is billed separately.
- No PSTN adapter is included; browser voice is the scope. A future PSTN transport should feed the same provider/session boundary and preserve the same executor.

# Running and presenting Relay

## Local development

Use the README commands. Compose publishes one loopback host port from `.env` `PORT` (default `3100`). Web listens on container port 3100 and forwards `/api/*` to API container port 3101. Neither API nor PostgreSQL publishes a host port. Database and API share the internal `database` network. API also joins the default network for web traffic and outbound provider access; web does not join the database network. For a local browser, set `WEB_ORIGIN=http://localhost:<PORT>`; for a public hostname, keep its HTTPS origin. A comma-separated origin list is supported when needed. HTTP, SSE and voice WebSocket requests use the page's origin, preserving the host-scoped HttpOnly ownership cookie.

After changing `PORT`, run `docker compose -f compose.yaml -f compose.app.yaml up -d api web`. Compose recreates changed services with the new mapping; `restart` alone cannot change it. No image rebuild is needed for a host-port change. In Compose, `PORT` means the external application port; the API container explicitly retains its internal `PORT=3101`.

On a remote development host use SSH forwarding:

```sh
ssh -L 3100:127.0.0.1:3100 your-dev-host
```

The forwarding command above assumes `PORT=3100`; replace both ports if yours differs. Then open the corresponding localhost URL. Browsers allow microphone capture on localhost; public hostnames need HTTPS.

## Database configuration

Set these once in `.env`:

```dotenv
POSTGRES_USER=relay
POSTGRES_PASSWORD='your-password'
POSTGRES_DB=relay
DB_HOST=db
DB_PORT=5432
```

Compose automatically reads `.env`. Its database service requires a nonempty `POSTGRES_PASSWORD`; no password is embedded in either Compose file. API, migrations, seed and integration tests build their connection URL from the same values, encoding reserved characters. Single-quote passwords containing `$` or `#` to preserve them in Compose. Do not use `${POSTGRES_PASSWORD}` inside `DATABASE_URL`: Node's env-file loader does not expand that syntax. An explicit `DATABASE_URL` remains available for an external database in host processes. Compose overrides it with an empty value and selects the local database through `DB_HOST=db`, `DB_PORT=5432`.

For a fresh database, choose the password before the first `docker compose up`. For an existing volume, changing `.env` alone **does not change the stored role password** ([Postgres image documentation](https://github.com/docker-library/docs/blob/master/postgres/content.md)). To rotate it without deleting data, open `docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, use interactive `\password`, enter the new password, then put the same value in `.env` and restart the API/recreate Compose services. Do not remove the database volume to apply a password change.

## Cloudflare Tunnel

A **named tunnel with a stable hostname** can route the whole app to `http://127.0.0.1:<PORT>` when `cloudflared` runs on this host (for example `http://127.0.0.1:3477` for `PORT=3477`). Next.js forwards `/api/*`, including WebSocket upgrades and SSE, to `api:3101` internally. When `cloudflared` runs as a container on the Compose default network, the service URL remains `http://web:3100`; `localhost` inside that container is not the host.

For example, with `PORT=3100`, create a published application route for `relay.example.com` → `http://127.0.0.1:3100`. Set:

```dotenv
WEB_ORIGIN=https://relay.example.com
COOKIE_SECURE=true
# Leave VOICE_PUBLIC_URL unset: the browser uses wss://relay.example.com automatically.
```

Replace the example hostname with yours and restart the API. If using Compose, recreate it with `docker compose -f compose.yaml -f compose.app.yaml up -d api web` after rebuilding when code changed. Prefer the production web build for a shared demo. TLS terminates at Cloudflare, so the local service URL remains HTTP. Add Cloudflare Access for the intended audience; the browser ownership cookie is session isolation, not login.

Optional locally managed configuration is in [infra/cloudflared.yml.example](../infra/cloudflared.yml.example); update its service port to match `.env`. Cloudflare evaluates ingress rules in order, and the final rule must be a catch-all ([routing configuration](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)).

Avoid `cloudflared tunnel --url ...` Quick Tunnels for this app: they **do not support SSE**, which drives the live dashboard ([Cloudflare limitation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). Local HTTP/SSE/WebSocket proxy checks do not prove an external Cloudflare deployment; after publishing, verify `/api/health`, live timeline updates and microphone connection on the HTTPS hostname.

## Docker app

The base `compose.yaml` only starts private PostgreSQL. Use both files for the application; migrations, seed and database tests run inside the API container. Stop host development processes using the app ports before starting the complete stack:

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

Add the chosen provider key privately. Never put it in a `NEXT_PUBLIC_*` variable. Proxy all requests, including WebSocket upgrades and SSE, to the web host port selected by `PORT`. See `infra/nginx.conf.example` and replace its example port. Configure matching hostnames so browser cookies reach both HTTP and voice routes. Gemini PCM travels through your server; OpenAI media travels directly from browser to OpenAI, with a trusted backend sideband for tools.

Demo identity maps all browser sessions to a fictional workshop customer. Separate browsers cannot open each other's session endpoints. The knowledge base and customer memory are shared demo data, not a private multi-tenant document service. Add real authentication and tenant ownership before using private customer documents or production workshop systems. No API route invokes external email, repair dispatch, real callbacks or paging.

## Data and recovery

- PostgreSQL is the source of truth. Back up the `relay_pg` volume or use `pg_dump` before changing the schema.
- Seed refreshes scenario templates and built-in knowledge idempotently; existing support sessions retain their snapshot. **Reset session** creates a fresh scenario and keeps history.
- SSE reconnect replays persisted events using a cursor; it does not rerun tools.
- Voice reconnect creates a fresh provider connection with a bounded application context. It does not claim provider-side session resumption or retry uncertain writes.
- A sensitive confirmation is consumed once. Approval is authorization, not execution success; inspect its completed/failed tool event. A failed or interrupted action must be reviewed before a fresh proposal.
- The Gemini default model was tested during implementation, but provider models and account quotas may change. Model IDs are configurable. OpenAI requires its own account access and is billed separately.
- No PSTN adapter is included; browser voice is the scope. A future PSTN transport should feed the same provider/session boundary and preserve the same executor.

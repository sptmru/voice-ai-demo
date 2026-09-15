# Running and presenting Relay

## Local development

Use the README commands. Keep API and web ports on `3101` and `3100`, PostgreSQL on `55432`. The web origin must match `WEB_ORIGIN` exactly; the default is `http://localhost:3100`, so use that URL rather than switching to `127.0.0.1` in the browser. A comma-separated origin list is supported when needed. The ownership cookie is host-scoped and HttpOnly, so the WebSocket connection to the API port keeps the same identity.

On a remote development host use SSH forwarding:

```sh
ssh -L 3100:127.0.0.1:3100 -L 3101:127.0.0.1:3101 your-dev-host
```

Then open `http://localhost:3100` locally. Browsers allow microphone capture on localhost; public hostnames need HTTPS.

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

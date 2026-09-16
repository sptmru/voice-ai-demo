# Relay — Voice AI Demo Studio

A client demo for appointment booking, lead qualification, order support and technical telecom support. Talk to an agent, see its actions, inspect the saved result, and hand the conversation to a human operator. The telecom foundation was built from [the implementation brief](docs/voice-ai-support-engineer-codex-prompt.pdf).

## Client demonstration

**Demo** opens the presentation view: choose a business scenario, start voice or choose **Start in text**, and follow the suggested messages. **Live workspace** retains the detailed tool, source and diagnostic view. The three new business scenarios use the same persisted sessions, events and tool executor as voice.

- **Book an appointment:** choose a consultation, inspect available slots and confirm one. With Google Calendar configured, the agent checks live availability and creates an actual calendar event. Without credentials it explicitly saves a local demo booking. See [Google Calendar setup](docs/calendar.md).
- **Meet your next customer:** collect the actual need, budget and timeline into a local lead record, with an optional consultation booking.
- **Help with an order:** inspect a fictional customer-owned order and confirm a delivery-change request. The request is saved locally for review; actual fulfillment is unchanged.
- **Talk to a person:** transfer the saved context into **Operator desk**, accept the conversation and reply as a human. AI tools and voice stop at transfer. The desk is an owner-scoped browser demonstration, not production staff authentication or a telephone transfer.

The original seven telecom scenarios remain available. The no-key text path is still a deterministic, finite workflow; voice models use scenario-specific instructions and the same validated tools. See the [demo walkthrough](docs/demo-script.md).

Existing installations need the additive `004_handoff.sql` migration and an operational reseed for the three new scenario templates. The startup commands below perform both. Migration/seed preserve existing sessions and uploaded documents. Google Calendar events survive deletion of their local demo session.

## Run locally

Requirements: Node.js **22.18+** (or newer compatible LTS), Corepack/pnpm, Docker with Compose, and approximately 2 GB free disk space for dependencies and the local model. Enable pnpm once with `corepack enable`, or use `corepack pnpm` in place of `pnpm`.

```sh
cp .env.example .env # only if .env does not already exist
docker compose -f compose.yaml -f compose.app.yaml build api
docker compose -f compose.yaml -f compose.app.yaml up -d db
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm db:migrate
docker compose -f compose.yaml -f compose.app.yaml run --rm api pnpm db:seed
docker compose -f compose.yaml -f compose.app.yaml up -d api web
```

Open **http://localhost:3100** with the example `.env`, or `http://localhost:<PORT>` for your configured port. `PORT` selects the single host port for web, `/api`, SSE and voice; health is `/api/health` on that same address. API and PostgreSQL have **no published host ports**: Next.js reaches `api:3101`, and API reaches `db:5432` on the internal `database` Docker network. Web belongs to the separate default network; API joins both. The first seed downloads the quantized local BGE model; subsequent container runs use the `relay_models` volume. Model download requires network access, inference does not. Seeding is repeatable and preserves previous sessions and uploaded documents.

Database commands and integration tests run inside the API container. Host-only `pnpm dev` / `pnpm dev:api` require a separately accessible database via `DATABASE_URL`; they cannot connect to this private Docker database by localhost. A host frontend also needs an explicitly reachable `API_INTERNAL_URL`; the Compose API is internal by default.

Database credentials live once in `.env`: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. Compose and host commands use these same values; `DB_HOST`/`DB_PORT` select the connection address. The application encodes password characters when building its connection URL. Keep passwords containing `$` or `#` single-quoted in `.env` so Compose treats them literally. An optional `DATABASE_URL` overrides these fields for host processes; the containerized API always uses the shared `POSTGRES_*` values and internal `db:5432` address. Changing `.env` does not rotate an already initialized PostgreSQL role's password; see [database configuration](docs/deployment.md#database-configuration).

For a public demo through Cloudflare, see [Tunnel setup](docs/deployment.md#cloudflare-tunnel): point the host-side tunnel to `http://127.0.0.1:<PORT>`. Changing `PORT` requires `docker compose -f compose.yaml -f compose.app.yaml up -d`; `restart` does not update port mappings. For direct local browser use also set `WEB_ORIGIN=http://localhost:<PORT>`; an HTTPS public origin does not change when only the local tunnel target port changes.

Select **UK carrier incident → Start session → Try…**. The agent runs real local tools, retrieves four knowledge chunks, finds the incident, opens a persisted ticket, and records a validated outcome. **End session** produces the after-call view and saves selective customer memory. **Session history** reopens the full record from the same browser.

**Start session** and **Reset session** automatically connect the selected voice provider when its key is configured. Allow microphone access when prompted. Missing credentials or denied microphone access leave the text workflow available; **Reconnect voice** retries a failed connection. Opening an old session from history does not start a new call.

Use the trash button on a knowledge document or session-history row to delete it after confirmation. Document deletion removes its indexed passages and embeddings from future retrieval; historical citations already saved in sessions remain. Deleting a session closes its call and removes its events, local tickets/actions, confirmations and memory derived from that conversation. Only the owning browser can delete a session. Knowledge is shared demo data. Running `db:seed` later restores deleted built-in documents from `docs/knowledge`; uploaded documents are not restored.

## Voice and implemented milestones

All five implementation milestones are present: the text support workflow, Gemini Live, ingestion and customer memory, the OpenAI Realtime adapter, and the responsive demo workbench. Select a provider and start a session; microphone connection starts automatically. Set `GEMINI_API_KEY` or `OPENAI_API_KEY` privately in `.env`; the default is Gemini. See [provider setup and transport differences](docs/providers.md).

Gemini was verified against the real API, including synthetic microphone speech through Chromium, live tools, retrieval, a persisted ticket and an outcome. OpenAI passes protocol and shared-scenario tests with simulated upstream transports; a real OpenAI call remains unverified because its key was not supplied. Browser audio is implemented; optional PSTN is outside scope.

## What is real and what is mocked

| Component                                  | Implementation                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operational systems                        | Real PostgreSQL persistence over fictional seeded telecom/account data; no actual carrier/CRM integration                                                                                 |
| Appointment calendar                       | Real Google OAuth, FreeBusy and event insertion when configured; explicit local demo fallback otherwise. No attendee invitations are sent. Live Google verification requires credentials. |
| Leads and store orders                     | Real local lead and delivery-change request records over fictional customer/order data; no external CRM or fulfillment updates                                                            |
| Human handoff                              | Persisted owner-scoped operator queue and browser text replies; stops AI voice/tools. No PSTN transfer or external dispatch                                                               |
| Text conversation                          | Explicit, evidence-driven deterministic policy, no LLM key required; finite support workflows, not a general chatbot                                                                      |
| Retrieval                                  | Actual local `Xenova/bge-small-en-v1.5`, 384-dimensional normalized embeddings, pgvector cosine + PostgreSQL full text, reciprocal-rank fusion                                            |
| Tickets, callbacks, follow-ups, escalation | Real local records; no email, callback, paging or external CRM dispatch                                                                                                                   |
| Sensitive reset                            | Explicit browser confirmation; simulated credential version changes atomically in session snapshot; never touches a live trunk                                                            |
| Events and reports                         | Real persisted tool, retrieval, transcript, confirmation, timing and outcome events, replayed over SSE                                                                                    |
| Identity                                   | Fictional Acme customer; random HttpOnly browser ownership cookie isolates session API access; not production account authentication                                                      |

The agent never exposes private model reasoning. Retrieved content is evidence, not instructions. The browser cannot select another customer through tool arguments. A spoken or typed “yes” cannot approve a sensitive tool; use its confirmation card.

## Validation

```sh
pnpm typecheck
pnpm test
# Uses the internal database network; creates and removes isolated test schemas.
docker compose -f compose.yaml -f compose.app.yaml exec api pnpm test:integration
pnpm exec playwright install chromium
# With the application running:
pnpm test:e2e
pnpm build
```

Verified on 2026-09-16: **80 unit tests, 46 PostgreSQL/integration tests and 12 browser tests passed**, along with type checking and the production build. New Google Calendar HTTP calls were mocked; live calendar access and deployment of this extension remain unverified. Full evidence and limitations are in [validation](docs/validation.md).

The production web build uses `.next-production`, separate from `.next` used by the dev server. Live verification scripts are documented in [providers](docs/providers.md); these make billed provider calls and are separate from automated fixture tests.

## Layout

```text
apps/web             Next.js dashboard
apps/api             Express HTTP + SSE and voice session transport
packages/core        Domain, tools, guardrails, support runtime
packages/db          PostgreSQL repository, migration, deterministic fixtures
packages/rag         Parsing, chunking, local embeddings, hybrid retrieval
packages/voice       Provider adapters and realtime interface
docs/knowledge       Ten fictional technical support documents
tests                Workflow, persistence, retrieval, provider and browser tests
```

See [architecture](docs/architecture.md), [official provider research](docs/provider-research.md), [deployment](docs/deployment.md), and the [recorded-demo script](docs/demo-script.md).

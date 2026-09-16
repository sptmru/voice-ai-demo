# Relay — Voice AI Demo Studio

A voice and text demo for **Relay Workshop**, a fictional appliance repair service in Yerevan. Ask about a fault, inspect the supporting documents, book diagnosis, check a repair request, or hand the conversation to an operator. The original telecom foundation remains available under additional scenarios.

## Client demonstration

**Demo** opens three repair scenarios; choose voice or **Start in text**:

- **Appliance troubleshooting:** describe a washing machine, dishwasher or refrigerator issue. Follow up with a warranty question; the agent keeps the appliance context and shows current sources. Unknown model/code combinations require clarification.
- **Book a repair:** describe the appliance and symptoms, then explicitly choose an offered diagnostic appointment. Rehearsal always creates a local booking; Live requires Google Calendar. Move or cancel an existing booking through its confirmation card. Home visits require a Yerevan address. See [calendar setup](docs/calendar.md).
- **Check repair status:** inspect fictional customer-owned request `REP-1042`. Its quote is awaiting approval. Confirm the exact quote on its approval card. New bookings create persistent repair requests; the operator can record diagnosis, a quote, readiness and collection.
- **Talk to a person:** transfer the saved conversation into **Operator desk**, accept it and reply. AI handling stops after transfer. This is an owner-scoped browser demonstration, not production staff authentication or telephone transfer.

Repair prices, jobs and the Relay appliance models are explicitly fictional. Repair text conversations use OpenAI or Gemini when configured, with the same validated tools as voice. Without a key, a finite extractive policy remains available. Photo reading extracts a visible model/error into an editable review card; only confirmed fields enter the conversation. Photos are sent to the configured vision provider and are not stored by this application. Rehearsal uses external AI when configured while keeping calendar actions local. Use **Check demo readiness** to warm local search and check provider configuration before a presentation. See [the workshop workflow](docs/workshop.md). Consultation, lead, order and seven telecom scenarios remain under **Other scenarios**. See the [walkthrough](docs/demo-script.md).

The knowledge base includes 16 current English repair documents, an archived warranty version and 10 telecom documents. RAG uses multilingual embeddings, RU/EN hybrid search, cross-encoder reranking, conversation context and evidence states (`supported`, `clarify`, `insufficient`, `conflict`). Sources show section, version and PDF page where available. See [RAG architecture and evaluation](docs/rag.md).

**Existing installations:** run migrations through `006_repair_lifecycle.sql`, seed the new templates/documents, then run `pnpm rag:reindex` to rebuild existing uploads with the new embedding model. Review [reindex instructions](docs/rag-reindex.md). Old uploads have only stored passages; recovering the original PDF is necessary for faithful page citations. Sessions and uploads are preserved; historical citations remain snapshots of the earlier answer. These commands change the selected installation, so run them when deploying the update.

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

Open **http://localhost:3100** with the example `.env`, or `http://localhost:<PORT>` for your configured port. `PORT` selects the single host port for web, `/api`, SSE and voice; health is `/api/health` on that same address. API and PostgreSQL have **no published host ports**: Next.js reaches `api:3101`, and API reaches `db:5432` on the internal `database` Docker network. Web belongs to the separate default network; API joins both. The first seed downloads multilingual E5; the first evidence query downloads the multilingual cross-encoder. Both run locally on CPU; subsequent container runs use the `relay_models` volume. Model download requires network access, inference does not. Seeding is repeatable and preserves previous sessions and uploaded documents.

Database commands and integration tests run inside the API container. Host-only `pnpm dev` / `pnpm dev:api` require a separately accessible database via `DATABASE_URL`; they cannot connect to this private Docker database by localhost. A host frontend also needs an explicitly reachable `API_INTERNAL_URL`; the Compose API is internal by default.

Database credentials live once in `.env`: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. Compose and host commands use these same values; `DB_HOST`/`DB_PORT` select the connection address. The application encodes password characters when building its connection URL. Keep passwords containing `$` or `#` single-quoted in `.env` so Compose treats them literally. An optional `DATABASE_URL` overrides these fields for host processes; the containerized API always uses the shared `POSTGRES_*` values and internal `db:5432` address. Changing `.env` does not rotate an already initialized PostgreSQL role's password; see [database configuration](docs/deployment.md#database-configuration).

For a public demo through Cloudflare, see [Tunnel setup](docs/deployment.md#cloudflare-tunnel): point the host-side tunnel to `http://127.0.0.1:<PORT>`. Changing `PORT` requires `docker compose -f compose.yaml -f compose.app.yaml up -d`; `restart` does not update port mappings. For direct local browser use also set `WEB_ORIGIN=http://localhost:<PORT>`; an HTTPS public origin does not change when only the local tunnel target port changes.

Select **Appliance troubleshooting → Start in text** and send the suggested washing-machine question. Inspect the sources, ask about warranty, then ask to book diagnosis. **End session** produces the after-call view and saves selective customer memory. **Session history** reopens the full record from the same browser.

**Start session** and **Reset session** automatically connect the selected voice provider when its key is configured. Allow microphone access when prompted. Missing credentials or denied microphone access leave the text workflow available; **Reconnect voice** retries a failed connection. Opening an old session from history does not start a new call.

Use the trash button on a knowledge document or session-history row to delete it after confirmation. Document deletion removes its indexed passages and embeddings from future retrieval; historical citations already saved in sessions remain. Deleting a session closes its call and removes its events, local tickets/actions, confirmations and memory derived from that conversation. Only the owning browser can delete a session. Knowledge is shared demo data. Running `db:seed` later restores deleted built-in documents from `docs/knowledge`; uploaded documents are not restored.

## Voice and implemented milestones

All five implementation milestones are present: the text support workflow, Gemini Live, ingestion and customer memory, the OpenAI Realtime adapter, and the responsive demo workbench. Select a provider and start a session; microphone connection starts automatically. Set `GEMINI_API_KEY` or `OPENAI_API_KEY` privately in `.env`; the default is Gemini. See [provider setup and transport differences](docs/providers.md).

Gemini was verified against the real API, including synthetic microphone speech through Chromium, live tools, retrieval, a persisted ticket and an outcome. OpenAI passes protocol and shared-scenario tests with simulated upstream transports; a real OpenAI call remains unverified because its key was not supplied. Browser audio is implemented; optional PSTN is outside scope.

## What is real and what is mocked

| Component                                  | Implementation                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operational systems                        | Real PostgreSQL persistence, owner-scoped repair jobs, revisions and lifecycle history over fictional service data; no external repair ERP, parts inventory or carrier integration           |
| Appointment calendar                       | Explicit Rehearsal/Live session mode; Google OAuth, FreeBusy, insertion, revision-bound rescheduling/cancellation. Rehearsal reservations persist locally. No attendee invitations are sent. |
| Leads and store orders                     | Real local lead and delivery-change request records over fictional customer/order data; no external CRM or fulfillment updates                                                               |
| Human handoff                              | Persisted owner-scoped operator queue and browser text replies; stops AI voice/tools. No PSTN transfer or external dispatch                                                                  |
| Text conversation                          | Repair conversations use configured OpenAI/Gemini with bounded tool calls; no-key fallback uses a finite deterministic policy                                                                |
| Retrieval                                  | Local multilingual E5 (384 dimensions), RU/EN full text + pgvector/RRF, multilingual cross-encoder, active/version/model filters and evidence admission                                      |
| Tickets, callbacks, follow-ups, escalation | Real local records; no email, callback, paging or external CRM dispatch                                                                                                                      |
| Sensitive reset                            | Explicit browser confirmation; simulated credential version changes atomically in session snapshot; never touches a live trunk                                                               |
| Events and reports                         | Real persisted tool, retrieval, transcript, confirmation, timing and outcome events, replayed over SSE                                                                                       |
| Identity                                   | Fictional Acme customer; random HttpOnly browser ownership cookie isolates session API access; not production account authentication                                                         |

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

Current repair/RAG verification, evaluation results and limitations are recorded in [validation](docs/validation.md). Conversation-level checks and optional live model evaluation are documented in [evaluation](docs/evaluation/CONVERSATIONS.md). Integration tests forcibly clear external provider credentials even when `.env` contains real keys. Run `pnpm rag:evaluate` in the API container for the 54-question isolated retrieval regression set.

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

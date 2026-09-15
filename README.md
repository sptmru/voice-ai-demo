# Relay — Voice AI Support Engineer

A local portfolio demo for a fictional telecom/CPaaS provider. Investigate calls, retrieve technical documentation, execute observable tools and produce a persisted support outcome. Built from [the implementation brief](docs/voice-ai-support-engineer-codex-prompt.pdf).

## Run locally

Requirements: Node.js **22.18+** (or newer compatible LTS), Corepack/pnpm, Docker with Compose, and approximately 2 GB free disk space for dependencies and the local model. Enable pnpm once with `corepack enable`, or use `corepack pnpm` in place of `pnpm`.

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open **http://localhost:3100**. API: `http://127.0.0.1:3101/api/health`. PostgreSQL: `127.0.0.1:55432`. Ports are deliberately separate from common 3000/3001 development servers. The first seed downloads the quantized local BGE model; subsequent runs use `.cache/models`. Model download requires network access, inference does not. Seeding is repeatable and preserves previous sessions and uploaded documents.

Select **UK carrier incident → Start session → Try…**. The agent runs real local tools, retrieves four knowledge chunks, finds the incident, opens a persisted ticket, and records a validated outcome. **End session** produces the after-call view and saves selective customer memory. **Session history** reopens the full record from the same browser.

## Voice and implemented milestones

All five implementation milestones are present: the text support workflow, Gemini Live, ingestion and customer memory, the OpenAI Realtime adapter, and the responsive demo workbench. Select a provider, start a session, then connect the microphone. Set `GEMINI_API_KEY` or `OPENAI_API_KEY` privately in `.env`; the default is Gemini. See [provider setup and transport differences](docs/providers.md).

Gemini was verified against the real API, including synthetic microphone speech through Chromium, live tools, retrieval, a persisted ticket and an outcome. OpenAI passes protocol and shared-scenario tests with simulated upstream transports; a real OpenAI call remains unverified because its key was not supplied. Browser audio is implemented; optional PSTN is outside scope.

## What is real and what is mocked

| Component                                  | Implementation                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Operational systems                        | Real PostgreSQL persistence over fictional seeded telecom/account data; no actual carrier/CRM integration                                      |
| Text conversation                          | Explicit, evidence-driven deterministic policy, no LLM key required; finite support workflows, not a general chatbot                           |
| Retrieval                                  | Actual local `Xenova/bge-small-en-v1.5`, 384-dimensional normalized embeddings, pgvector cosine + PostgreSQL full text, reciprocal-rank fusion |
| Tickets, callbacks, follow-ups, escalation | Real local records; no email, callback, paging or external CRM dispatch                                                                        |
| Sensitive reset                            | Explicit browser confirmation; simulated credential version changes atomically in session snapshot; never touches a live trunk                 |
| Events and reports                         | Real persisted tool, retrieval, transcript, confirmation, timing and outcome events, replayed over SSE                                         |
| Identity                                   | Fictional Acme customer; random HttpOnly browser ownership cookie isolates session API access; not production account authentication           |

The agent never exposes private model reasoning. Retrieved content is evidence, not instructions. The browser cannot select another customer through tool arguments. A spoken or typed “yes” cannot approve a sensitive tool; use its confirmation card.

## Validation

```sh
pnpm typecheck
pnpm test
# Requires the local PostgreSQL container; creates and removes isolated test schemas.
pnpm test:integration
pnpm exec playwright install chromium
# With pnpm dev running:
pnpm test:e2e
pnpm build
```

Verified on 2026-09-15: **50 unit tests, 36 PostgreSQL/integration tests and 4 browser tests passed**, along with type checking and the production build. Full evidence and limitations are in [validation](docs/validation.md).

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

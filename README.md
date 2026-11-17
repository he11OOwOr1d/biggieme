# minimi

A small chat agent with one web-search tool, date-aware conversation recall, and a bounded user profile.

## Run

Requires **Node 24+** (built-in SQLite), then:

```sh
npm install
cp .env.example .env
# Add one model provider key and TAVILY_API_KEY to .env.
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The interface runs without keys and shows setup instructions; generation and live search need credentials. There are no fake answers or subscription credentials.

## Providers

| Provider | Environment |
| --- | --- |
| OpenAI | `OPENAI_API_KEY`; optional `OPENAI_MODEL` (defaults to `gpt-6-luna`) |
| Anthropic | `ANTHROPIC_API_KEY` and an accessible `ANTHROPIC_MODEL` |
| OpenAI-compatible | `COMPATIBLE_BASE_URL`, `COMPATIBLE_MODEL`, `COMPATIBLE_API_KEY` |
| Local endpoint without authentication | Same compatible configuration; use `COMPATIBLE_NO_AUTH=true` instead of a key |
| Web search for every provider | `TAVILY_API_KEY` |

For OpenRouter, set `COMPATIBLE_BASE_URL=https://openrouter.ai/api/v1` and your chosen model ID. For a local OpenAI-compatible service, point the base URL at its `/v1` endpoint. Models need streaming and function calling. Provider-specific unsupported features are not automatically emulated. The provider dropdown shows only server configuration; keys never enter the browser.

## Check and build

```sh
npm test
npm run bench
npm run build
npm start
```

`npm start` serves the built frontend. `npm run dev` serves both the API and Vite through one port. Background memory extraction can be disabled with `MEMORY_EXTRACTION=false`; raw transcript recall still works.

## Data and hosting

`data/minimi.sqlite` is the source of truth. Each signed browser session has isolated conversations and a profile. JSONL exports and `USER.md` views live under `data/users/<id>/`. Use the header export button to download a conversation. The memory panel shows saved facts, supporting quotes, and a forget action. Clearing browser cookies loses access to that browser’s space; this prototype has no account recovery.

Keep `data/` on a persistent volume with one Node process. Back it up with SQLite’s backup facilities; do not copy an active database file without its WAL. Do not deploy this filesystem-backed version to ephemeral serverless storage. Set `HOST=0.0.0.0` and `APP_ACCESS_TOKEN` for a private hosted demo, behind an HTTPS reverse proxy. The process refuses a public bind without an access token. Configure the proxy to preserve the request host and origin. A shared demo access code is not a substitute for production accounts, per-user quotas, or managed secrets. All visitors use the host’s provider keys and their associated billing.

The model receives relevant chat/profile records. Tavily receives model-generated search queries; prompts instruct the agent to exclude private user details. Raw conversation history is stored locally and is not an encrypted secrets vault.

## Design

Read the one-page [DESIGN.md](DESIGN.md), detailed [ARCHITECTURE.md](ARCHITECTURE.md), and sourced [RESEARCH.md](RESEARCH.md). No public deployment or GitHub publication is performed by the app.

## Live endpoint verification before submission

Run `npm run build` and `npm test` first. Then run:

```sh
npm run test:luna
```

This explicitly selects `gpt-6-luna` through the OpenAI Responses API. Add your own
`OPENAI_API_KEY` and `TAVILY_API_KEY` to `.env`; credentials must have model access
and sufficient quota. A missing OpenAI key produces **BLOCKED**, never a passing
Luna result. The test does not borrow credentials from Codex or another provider.

The runner starts a separate production server on a random localhost port with a
temporary database. It verifies frontend asset HTTP responses, access control,
conversation CRUD, streamed model completion and persistence, background memory
extraction, cross-chat recall, live Tavily search, a fresh-search follow-up,
exports, individual message access, forgetting a fact, and conversation cleanup.
It uses synthetic messages and deletes its temporary database afterward. Existing
conversations are untouched. Live calls use your provider quota.

Reports: `test-results/live-openai.md` and `.json`. Exit codes: **0** all checks
passed, **1** a check failed, **2** checks blocked by missing credentials or a
failed prerequisite. Reports identify the actual model and run time. These checks
confirm endpoint/integration behavior, not browser rendering, research accuracy,
or equivalence to a leading search product.

To test the currently configured Groq/compatible model separately:

```sh
npm run test:live -- --provider=compatible
```

That creates a separate `live-compatible` report and is not evidence of Luna access.

### Groq free-plan verification

For `api.groq.com`, the live runner waits 65 seconds between chat scenarios so
its model calls and background memory extraction do not compete for the free
8,000-token/minute allowance. A full run therefore takes several minutes. The
app uses strict search-tool arguments for Groq, validates allowed page URLs in
application code, and uses low reasoning effort for GPT-OSS models. Rate limits
still apply during ordinary use; the test does not increase the account quota.

## Vercel deployment

The Vercel entry point is `api/index.ts`. Hosted mode requires `STORAGE_MODE=blob`,
a private Vercel Blob store, a stable random `SESSION_SECRET`, and `APP_ACCESS_TOKEN`.
Provider and Tavily keys are server-side environment variables. Do not upload `.env`
or `data/`. Local development continues to use the original local SQLite database.

Hosted storage keeps one private SQLite snapshot per signed browser identity.
Each request loads the latest snapshot into a disposable directory; mutations
save it using an ETag precondition before reporting success. Competing writes are
rejected rather than silently overwriting data. Memory extraction runs before the
hosted completion event and snapshot save so it cannot be lost when a function
freezes. This small-demo approach copies the user's database per request; it is
not designed for large histories or high traffic. Use a managed database for that
scale. Existing local conversations are not automatically uploaded.

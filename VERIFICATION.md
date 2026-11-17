# Submission verification

Checked 17 November 2026. Project: minimi.

## Result

**PASS for the configured Groq + Tavily endpoint/integration suite.**

- `npm run build`: TypeScript check and production frontend build pass.
- `npm test`: all 23 automated tests pass, including strict Groq tool serialization, required tool choice with SDK validation, URL-read protection, memory provenance/deletion, streaming, and ownership checks.
- `npm run test:live -- --provider=compatible`: all live checks pass with `openai/gpt-oss-120b` on Groq and Tavily. This used real provider calls through an isolated production HTTP server and a disposable database, without mocks or changes to existing user conversations.

## Live evidence

Run completed: 2026-11-17T06:16:40.059Z (UTC).

| Check | Result | Detail |
| --- | --- | --- |
| Frontend HTTP and assets | PASS | HTML and built JavaScript return 200 (browser rendering not tested) |
| Access gate and signed sessions | PASS | Configuration returned; selected model openai/gpt-oss-120b; secrets absent |
| Conversation endpoints and ownership | PASS | Create/list/read work; other-user access and cross-origin mutation rejected |
| Direct Tavily endpoint | PASS | 3 live results received; verifies search credentials independently of the model |
| Live model chat and persistence | PASS | Completed and persisted; 870 ms |
| Memory extraction and cross-chat recall | PASS | Preference saved; new conversation recalls project and answer style |
| Search and source persistence | PASS | 2 sources persisted; 2122 ms; factual accuracy not graded |
| Follow-up with fresh search | PASS | Follow-up completed with 10 sources; 58245 ms; correctness not graded |
| Forget memory endpoint | PASS | Fact removed through API |
| Export and individual message endpoints | PASS | 2 exported records; message lookup and isolation verified |
| Conversation deletion and memory cleanup | PASS | Test conversations deleted; memory endpoint empty |

## Fixes verified

Groq search calls now use strict function schemas with complete arguments. The model-facing schema avoids Groq's unsupported URI format; application URL validation and source allowlists remain enforced. Explicit freshness requests force the named `web_search` tool. GPT-OSS uses low reasoning effort. The live runner spaces chat scenarios 65 seconds apart to respect the free token allowance. Normal application requests still share the provider's quota and may receive rate-limit errors.

The live research follow-up took about 58 seconds. The app's default response deadline is 120 seconds.

## Scope and limits

This confirms endpoint connectivity, streaming completion, persistence, search execution, memory extraction/recall, export, and cleanup for the recorded Groq configuration. It does not establish answer accuracy, citation quality, browser rendering or performance against market benchmarks. It is one successful complete live run after fixes, not a reliability or load-test claim.

**GPT-6 Luna and Claude: live testing pending credentials.** No OpenAI or Anthropic API key is configured, and neither model was invoked. Their provider adapters are implemented; the Groq pass is not evidence of live Luna/Claude access.

## Reproduce

```sh
npm run build
npm test
npm run test:live -- --provider=compatible
```

Use configured `COMPATIBLE_BASE_URL`, `COMPATIBLE_MODEL`, `COMPATIBLE_API_KEY`, and `TAVILY_API_KEY` in `.env`. Never include `.env` or the `data/` directory in a public submission. Real calls consume provider quota; the free-plan live suite takes several minutes due to deliberate pacing.

Detailed reports: `test-results/live-compatible.md` and `.json` (ignored by Git). This summary is kept in the project for submission. The existing Luna command is `npm run test:luna`; it will report BLOCKED until an authorized OpenAI key is configured.

## Hosted verification

The project is deployed on Vercel with private Blob snapshot persistence. Hosted chat, memory, search, export, and cleanup were tested on 17 November 2026. See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact deployed commit, access requirements, evidence, and build-log limitation.

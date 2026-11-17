# Research notes

Checked 15 November 2026. These are primary sources; the architectural choices are our conclusions rather than claims that a source prescribes this implementation.

| Source | Finding and resulting decision |
| --- | --- |
| [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | Documents the exact model ID, streaming, tool calling and structured output. Use it as the default; account access and actual task performance still need a live test. |
| [AI SDK introduction](https://ai-sdk.dev/docs/introduction) | Provides a common TypeScript model interface, streaming and agent primitives. Chosen for provider portability. Installed version is recorded in `package-lock.json`; implementation was checked against its bundled documentation. |
| [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), [compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) | Direct adapters permit operator-owned API keys without requiring a gateway. We keep provider-specific options localized. |
| [OpenAI Agents SDK: AI SDK integration](https://openai.github.io/openai-agents-js/extensions/ai-sdk/) | A viable way to use alternative providers inside OpenAI’s agent orchestration. Our single-tool loop does not require the extra layer. |
| [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | Embeds the Claude Code runtime, tool loop and capabilities. We use the Anthropic model adapter for this narrowly scoped chat rather than importing a coding-agent runtime. |
| [Pi model library](https://github.com/earendil-works/pi/tree/main/packages/ai) and [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) | Offers another unified provider layer and inspectable JSONL session records. Borrow record transparency; we do not need session branching or its full harness. |
| [LangChain JS overview](https://docs.langchain.com/oss/javascript/langchain/overview) | Another credible multi-provider agent stack. Its additional abstractions are unnecessary for this scope. |
| [ACP introduction](https://agentclientprotocol.com/get-started/introduction) | Standardizes communication between editors and coding agents. This is different from the model provider adapter needed here. |
| [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) | Separates bounded profile/notes from SQLite FTS5 session history. Borrow the separation, caps and provenance; implement retrieval in backend code to preserve the one-tool challenge contract. |
| [SQLite FTS5](https://sqlite.org/fts5.html) | Supports full-text matching, BM25 and excerpts in the local database. Avoid a separate vector service for the first version. |
| [Chrono date parsing](https://github.com/wanasit/chrono) | Supports a reference instant/timezone and inspecting explicit date components. Add application policies and local calendar intervals rather than relying on parser defaults. |
| [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) | Search exposes latency/relevance options; extraction supplies page text. Use one model-facing search tool backed by both operations, with explicit bounds and freshness metadata. Provider “fast” modes are not a measured end-to-end latency guarantee. |
| [OpenAI latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization) | Recommends measuring first text and total latency, reducing sequential requests, streaming and parallelizing independent work. Keep recall local and avoid a mandatory planner call. |
| [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | Discusses selective retrieval and compact working context. Store everything necessary for audit, inject only relevant evidence. |
| [LongMemEval](https://xiaowu0162.github.io/long-mem-eval/) | Evaluates extraction, multi-session reasoning, knowledge updates, temporal reasoning and abstention. Those abilities inform our evaluation matrix; the app has not been benchmarked on its dataset. |

## Subscription path considered and rejected

The [official plan-usage docs](https://developers.openai.com/siwc/token-sharing-open-source) describe authorized local/open-source use, while [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) constrain supported requests and tools. The user chose API-key production support instead. No subscription tokens, Codex/Claude subprocesses, OAuth credential scraping, or undocumented endpoints are part of this implementation.

## Evaluation before public submission

Seed separate users and dated conversations, then ask unseen variants. Record original-message recall, entity/list recall, date resolution, citation support, correct change classification, abstention and latency. Include:

- A five-vendor CRM shortlist, with one changed price, one release, two unchanged pages and one unavailable source.
- A November 3 answer that was wrong originally; the agent should correct it instead of declaring a later change.
- Last Tuesday across midnight, DST, month/year rollover, and a contradictory weekday/date.
- Two different shortlists on the same day and matching November dates in multiple years.
- Deleted/forgotten facts, profile saturation, immediate follow-ups before extraction completes, and interrupted streams.
- A web page or old transcript containing instructions to ignore the live request; retrieved content remains evidence.
- No prior conversation at all; the agent should not fabricate the missing shortlist.
- A provider lacking tool calling; report the limitation rather than silently inventing search results.

The deterministic test suite exercises infrastructure and a mocked agent/search flow. This evaluation matrix requires real model/search access and is deliberately not presented as completed.

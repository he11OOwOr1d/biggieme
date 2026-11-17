# minimi

**The hard part is answering “what changed since our conversation?”** The agent must recover what was actually discussed, distinguish an old answer from a verified fact, and check current evidence. A fast answer to the wrong remembered question fails the task.

## How it works

React provides a quiet, streaming chat interface. One Node process owns the API, SQLite database, and agent. AI SDK’s `ToolLoopAgent` provides the bounded tool loop. Direct adapters support OpenAI (default `gpt-6-luna`), Anthropic, and configurable OpenAI-compatible endpoints. Credentials stay on the server. Models must support streaming and tool calling; compatibility is a capability requirement, not a promise about every model.

The model has exactly **one tool: `web_search`**. It batches targeted Tavily searches and can read URLs already found in search or historical citations through that same tool. Independent requests run concurrently; ordinary searches have a short cache, while freshness checks bypass it. Search failures and observation timestamps travel with the evidence. Reading an official page is preferable to trusting a pricing snippet. Retrieval time never establishes when a price change took effect.

Memory retrieval happens before inference, without another model round trip. A timezone-aware calendar lookup and SQLite FTS5 recover original messages plus neighboring turns across conversations. Conversation timestamps and dates mentioned in messages are separate. Date-only questions work without keywords. Missing years produce historical candidates; conflicting evidence calls for clarification. Records have IDs for clickable history citations, and truncated coverage is disclosed.

A background model call proposes at most three explicitly supported durable facts per completed turn. Exact user quotes and source IDs are required; code enforces a **1,600-character profile cap**. Corrections replace keys, older jobs cannot undo newer corrections, and forgetting blocks delayed jobs from restoring old facts. The generated `USER.md` is a small view, not a diary. Complete transcripts remain searchable even when extraction fails or the profile fills. Deleting a conversation removes its sourced facts and search entries.

SQLite is authoritative. Per-conversation JSONL exports append committed messages and are atomically rebuilt at startup. Answers retain the source excerpts actually returned by search and page reads. An assistant’s previous claim remains an assistant claim. Partial responses are marked incomplete and excluded from answer retrieval.

## Tradeoffs and validation

I chose direct AI SDK providers over ACP (editor-to-agent transport), subscription wrappers, or OpenAI Agents SDK plus a second provider adapter layer. I borrowed bounded profiles and searchable history from Hermes, and simple inspectable records from Pi. I rejected vector databases, knowledge graphs, multi-agent orchestration, and recursive summaries for this version. Keyword search can miss paraphrases; incomplete evidence should trigger a focused question, not invented recall.

Tests cover dates/DST, event dates, user isolation, corrections, capacity, forgetting, JSONL, search caching/failure, and a mocked SDK tool-to-answer flow. Live provider quality and latency require funded API keys; no benchmark result is claimed. The demo uses signed browser sessions and an optional access gate, not production account authentication.

**Another week:** run a held-out temporal/memory evaluation and live latency measurements; add query rewriting or small local embeddings only for demonstrated recall failures; add real accounts, durable memory jobs, and stronger historical source snapshots. See [ARCHITECTURE.md](ARCHITECTURE.md) for contracts and limitations, and [RESEARCH.md](RESEARCH.md) for primary sources.

# Deployment

Production: https://biggieme.vercel.app

Vercel project: `biggieme`, team `forchatgptnik-gmailcoms-projects`.
GitHub: https://github.com/he11OOwOr1d/biggieme
Deployed source commit: `c1b4e9d4221f6c061d81d2587cf13b59231753fd`.
Runtime: Node 24, Mumbai (`bom1`).

Vercel authentication remains enabled. The application also requires its demo
access code. The code is stored only on the owner's computer in the ignored file
`.vercel/deployment-access.txt`; it is not included in this repository.

Model and search: Groq `openai/gpt-oss-120b` and Tavily. Keys are in Vercel environment
variables, not frontend code or Git. GPT-6 Luna and Claude are not configured.

Persistence: a private Vercel Blob store holds one SQLite snapshot per signed
browser identity. Each request reloads a fresh copy; conditional ETag writes
prevent silent lost updates. This is small-demo storage, not a high-traffic database.
Existing local chat histories were not imported.

Verified 17 November 2026:

- Build and all 23 automated tests pass; npm audit reports zero vulnerabilities.
- Hosted access gate and HTTPS-origin handling pass.
- Creating a conversation and reading it on a separate request pass.
- Real Groq streaming, answer persistence, and preference extraction pass.
- Export and deletion of a conversation and sourced memories pass.
- Real hosted web search passes: two sources persisted, response in about 4.7 seconds.
- No application error/fatal logs were found in the post-deployment scan before
  the final search request. Browser rendering and research-answer accuracy were not graded.

Vercel's function transpilation prints a missing Node type-definition diagnostic
(TS2688), although the full TypeScript/build check passes and the deployed API
runs successfully. The deployment is READY; retain this note when reviewing build logs.

Groq's free quota and Vercel's included quotas still apply. Shared access does
not provide production accounts, account recovery, or per-user billing limits.

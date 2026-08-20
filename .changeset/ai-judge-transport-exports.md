---
'@pwtap/plugin-ai-judge': minor
---

Export the transport, the routing and the endpoint table, so another pwtap tool can ask a model a question whose answer is not a verdict

`@pwtap/plugin-heal`'s escalation tier asks a model to pick a failure class. That cannot travel through
`AIProvider`, whose `judge` returns a `JudgeVerdict` — but retries, `Retry-After` handling, per-attempt
deadlines, prefix routing (`local/`, `groq/`, `anthropic/`…) and brace-balanced JSON extraction are the
same problems, already solved here and load-bearing.

Newly public: `judgeFetch`, `judgeTimeoutMs`, `kindForModel`, `providerForKind`, `stripPrefix`,
`extractJsonObject`, and a new `endpointForKind` returning `{ label, wire, baseUrl, apiKey }` for a
registered kind.

`endpointForKind` exists so there is **one** table of gateway base URLs in the repo. The alternative
was a second copy in the healer, and a drifted base URL is a confusing 404 for whoever set `groq/…` in
their config. `registerProvider` accordingly accepts an optional `endpoint` alongside the provider: a
custom transport that passes one serves the healer as well as the judge, which a provider alone cannot.

No behaviour changes for existing judge callers — the registry gained a field and the parser's
`extractJsonObject` gained an `export` keyword.

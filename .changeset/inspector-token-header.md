---
'@pwtap/mobile-inspector': minor
---

Keep the launch token out of printed output and off disk

`mobile-inspect` printed `http://127.0.0.1:<port>/?token=<secret>` on every launch. That token authorises a
service which spawns processes and writes files inside the project, and printed output is the least private
place there is: terminal scrollback, a screenshot, a pasted log, a recorded pairing session. It was also
stored in the single-instance lock file under `node_modules`, world-readable, for the length of the session.

Neither was necessary:

- **The window carries the token in an `x-inspector-token` header**, set on the Playwright browser context, so
  it covers the navigation and every subresource — the page, the bundle, the event stream, each frame. The
  launch now prints `http://127.0.0.1:<port>` and nothing else. The token no longer appears in printed output,
  in the page's own `location`, or in the browser profile, and it was already kept out of `ps` by navigating
  after launch rather than passing `--app=<url>`.
- **The lock file holds port and pid only.** It carried the token so a second launch could quote a
  ready-to-open URL; a port and a pid are enough to say "that one is running, use it or stop it".
- **`?token=` still works**, because a browser this process did not launch cannot be given a header. That URL
  is printed only when no window could be opened, and the line says it contains a secret. The cookie the first
  such request sets is unchanged, so the hand-opened path keeps working for assets, events and frames.

Duplicate `x-inspector-token` headers are refused rather than resolved — Node folds them into one
comma-separated value, and accepting a prefix would let a caller append a guess to a real token.

Nothing to change in a project: `npm run mobile:inspect` behaves the same, minus the secret in the log. Anyone
scripting against `startInspectorService()` gets a new token-free `origin` on the handle; `url` still carries
the query token and now documents when using it is appropriate.

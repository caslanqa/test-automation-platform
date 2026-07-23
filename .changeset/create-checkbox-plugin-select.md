---
'@pwtap/create': minor
---

Replace the "type comma-separated numbers" plugin picker with an arrow-key checkbox list (↑/↓ move, space toggle, enter confirm). Coming-soon plugins are shown but the cursor skips over them. Non-interactive scaffolds (`-y` or no TTY) are unaffected — they still take `defaultSelected` plugins automatically.

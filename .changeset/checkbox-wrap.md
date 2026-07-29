---
'@pwtap/create': patch
---

Fix the plugin checkbox duplicating a line when you press space

The redraw moved the cursor up by the number of plugins, which is the number of physical rows only when no entry
wraps — and the real entries are 88 to 141 characters, so at 80 columns every one of them wrapped. The rows the
count missed stayed on screen and the next draw landed underneath them, so a toggle looked like it duplicated the
line. Measured in a pseudo-terminal: the old renderer asked for `ESC[4A` at both 200 and 80 columns, right at the
first width and two rows short at the second, which is why this survived until someone used a normal terminal.

Entries are now truncated to the terminal width, so the list is always one row per plugin and the arithmetic is
trivially right; the redraw also clears to the end of the screen rather than line by line, so a resize between two
draws cannot leave a wider row behind. The header hint is two lines, since as one it was 57 characters and wrapped
on a narrow terminal.

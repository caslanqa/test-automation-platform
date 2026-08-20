---
name: acceptance-criteria
description: 'How to turn a requirement into criteria a test can actually check, and how to spot the ones that cannot be verified as written. Use before designing or writing any test from a ticket, story, or prose requirement.'
requires: core
---

A criterion is testable when a test can read the thing it names. Three properties, all required:

- **Observable** — names a rendered string, an HTTP status, a response field, a redirect, or stored
  state. "The user is informed" is not observable; "an error with the text `Card expired` appears
  below the card field" is.
- **Bounded** — says when, or within what. "Quickly" is not a criterion. Either give a threshold or
  drop the timing claim; a threshold you invented is worse than no threshold, because a test will
  enforce it forever.
- **Attributable** — says which actor. Behaviour usually differs by role, and the suite has named
  users in `testData/users.json` for that.

## The template

```
Given <state>, when <action>, then <observable> — at the <api|ui|data> layer.
```

The layer tag is not decoration. It is what makes a layer decision possible downstream. A criterion
with no stated observable cannot be assigned a layer, and an unassignable criterion is an
unverifiable one wearing a suit.

## Always produce the negative path

Requirements describe success; suites earn their keep on failure. For every happy path, write the
criteria for:

- invalid input (and the value exactly at the boundary, plus one past it)
- an unauthenticated caller
- an authenticated caller **without** the permission
- a dependency that is unavailable
- the same action performed twice (is it idempotent, and does the second attempt say so?)

If the requirement is silent about one of these, that silence is a finding to report — not a gap to
fill with your own assumption.

## The "not verifiable as written" list

Keep it separate and keep it short. For each entry name the missing piece and the one question that
resolves it:

| Missing               | Ask                                                      |
| --------------------- | -------------------------------------------------------- |
| a threshold           | "within how long, and measured from what?"               |
| the actor             | "which role sees this?"                                  |
| the failure behaviour | "what does the user see when it fails?"                  |
| the source of truth   | "which system owns this value?"                          |
| the observable        | "how would someone outside the code tell this happened?" |

## What not to do

Do not convert a vague requirement into a precise-looking criterion by choosing the missing value
yourself. That does not remove the ambiguity — it hides it inside a passing test, where it will be
mistaken for a decision someone made on purpose.

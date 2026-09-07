---
name: launch-proof
description: Verify and hand off a completed product or feature with real execution evidence using take-a-repo. Use at the completion of implementation in a repo configured for take-a-repo, or when preparing a runnable release proof for a browser, native app, CLI or API. Not for ordinary questions, reviews, or unrelated maintenance. No automatic publication or user approval.
---

# Turn completed implementation into reviewable evidence

When the requested feature is implemented, its configured completion proof is
part of the handoff; the user need not separately request a screenshot. First
inspect `take-a-repo.config.js` and the actual commands before executing them.
`take-a-repo inspect <repo> --json` only discovers capabilities; it never runs
repository code. A missing config requires product-specific intent, not guessed
claims. Read the package's [evidence contract](../../docs/evidence.md) to author
one when release-proof creation is within the user's request.

Use the product's existing execution tool: Playwright for browser interactions,
a repo-owned Appium/Maestro/fastlane/native runner for native UI, executable
checks for a CLI, actual request/response assertions for an API. Do not build a
web mock to stand in for a native or nonvisual product. The shared engine accepts
their evidence; it does not implement every platform's automation driver.

Run `take-a-repo <repo> --json` (or the source checkout's absolute
`bin/take-a-repo.js` with Node). Match every product claim to an observed check,
including meaningful failure behavior. A screenshot proves appearance, not a
successful transaction. Imported media and checks remain unverified until the
product is actually exercised. Do not replace a failed check with `pass` to make
the delivery green.

Read the returned run report and its `actions`. Fix the responsible producer,
assertion, story or rendering recipe, then recapture. Increment `--attempt`; stop
and explain when the configured budget is exhausted, a required permission or
external dependency is missing, or fixing the issue would expand the request.
Scoped evidence runs are diagnostic only; run the full config before final
review. Each execution creates a separate candidate; never reuse old approval.

When machineStatus is `publish-ready`, run
`take-a-repo review <outDir> --json` and show its local URL. Let the user inspect
the resulting files and choose Approve or Request changes. Do not call the
review endpoint, click Approve, or write review.json on the user's behalf.
`take-a-repo status <outDir> --json` rechecks file bytes and returns feedback with
deliverable, source and claim references. Apply requested changes to those
inputs and recapture, then return for new user review.

Do not publish, upload, install globally, edit unrelated agent settings, or add
background monitors as part of evidence collection. Even an approved file set
does not authorize a new external destination. Report exactly what was run,
what was verified, and what still needs user review.

Discovery depends on the host loading this skill or the consumer's AGENTS.md
completion rule. Merely publishing an npm package does not make every LLM find
or invoke it.

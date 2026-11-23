# structured-blocker-reasons

Task: replace backend-composed Chinese UI text with structured fields for
`Upstream.state_reason` and `PublishedTarget.blocked_reason`.

Branch: pi-subagents/be-admin-Upstream.state_reason-PublishedTarget.blocked_reason-18-11-refused-proto-agent-1649bee6-38b7f74-b177-s0-t0

## Status

- [x] proto changed + `mise run proto` (two artifacts)
- [x] upstream-state / platform-state / service / models
- [x] tests updated + reverse-proof (must go red)
- [ ] gates: check:admin, check:routing, typecheck, privacy (running)

## Log

- started; no docs/tasks/*/context.md present in this worktree, task message is the context
- supervisor confirmed target blocker semantics: disabled target stays blocked=false + UNSPECIFIED; blockerReason only for OUT_OF_CREDITS/COOLING; enum keeps only backend-producible values (UNSPECIFIED=0, UPSTREAM_DISABLED=1, NO_CREDENTIAL=2, CREDENTIAL_EXPIRED=3, CREDENTIAL_REJECTED=4, OUT_OF_CREDITS=5, COOLING=6, QUEUED=7, LOGGING_IN=8, UNKNOWN=9); removed TARGET_DISABLED/MODEL_GONE

- proto regenerated (buf generate + web gen:sync); lib/gen tracked, web/.gen gitignored
- typecheck green; 3 tests green (cooldown 48/48, parity 89/89, breaker 49/49)
- reverse-proof #1: coolingAccounts forced 0 → 3 cooldown assertions red (cooling count in cooling block / two-account block / refused block); restored
- reverse-proof #2: blocker forced UNSPECIFIED → 3 cooldown + 1 parity assertions red; restored
- parity test: initial over-assertion on credential.status fixed (expired session reports credential MISSING, a separate field); now asserts platform state enum

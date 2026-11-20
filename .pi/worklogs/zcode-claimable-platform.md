# zcode claimable accounts at platform level

- Started from the task brief in the subagent prompt; no docs/tasks/<task>/context.md exists in this worktree.
- Goal: record offers count in ZcodeClaimSnapshot, add Upstream.claimable_accounts proto field, count eligible accounts in lib/admin/upstreams.ts, tests + counter-proof.
- Mid-run steering: also expose the activity name. Added `Upstream.claimable_label = 36`, snapshot `offerName`/`offerPriority` from marketing/touch, selected by smallest offer priority.
- Snapshot facts are written directly into the claim object (record() used to build a merged copy; `peekHealthSnapshot` returns a copy, so that path did not persist `offers`).
- Tests: `test/zcode-claim-check.ts` section 14; new `test/admin-claimable-check.ts` registered as `test:admin:claimable` in check:admin and test matrix.
- Counter-proofs (real red runs captured):
  - `claimableAccounts` forced to `return 0` → "未领的算一个，claimed 的不算 → 1 — 0" FAIL.
  - `service.ts` field forced to `0` → "面板 Upstream.claimableAccounts 用的是快照判据" FAIL.
  - `claimableLabel` forced to `""` → two label assertions FAIL.
- Gates run: typecheck, check:admin, check:kinds, test:verify, privacy, proto regeneration.

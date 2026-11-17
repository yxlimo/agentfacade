// lib/router/stream-limits.ts — the ceiling on the two stream gates.
//
// One number, three readers:
//
//   lib/router/deliver.ts        the two gates themselves (idleGates)
//   lib/admin/config.ts          what the panel shows and what it may write
//   lib/fetch-dispatcher.ts      the lower layer that must stay looser
//
// Why a ceiling at all: the gate that ends a quiet upstream is ours, but the
// layer below it (undici's bodyTimeout) also ends one. If the lower layer is
// the stricter of the two, it fires first and the client sees Node's
// `terminated` instead of our sentence — our setting becomes decoration and
// our error text never reaches anybody. So the lower layer must always be
// looser, and the ceiling is what keeps that true: an operator can turn the
// gate up to STREAM_LIMIT_MAX_MS, never past it, and the fetch layer is
// derived from the same number.
//
// This module is a leaf on purpose: it has no imports, so anything may read
// it (including the admin layer, which must not drag the router in).

/**
 * The largest value either gate may take (milliseconds).
 *
 * It is deliberately below the fetch layer's body timeout (which is derived
 * from this number): see lib/fetch-dispatcher.ts.
 */
export const STREAM_LIMIT_MAX_MS = 600_000;

/**
 * How long to wait for the upstream's first frame (milliseconds) — the
 * default of ROUTER_FIRST_FRAME_MS.
 *
 * Reasoning models often need two minutes or more before the first token, so
 * this is measured separately from the mid-stream limit: a normal thinking
 * stream must not be cut by the shorter mid-stream window.
 */
export const STREAM_FIRST_FRAME_DEFAULT_MS = 300_000;

/**
 * How long a gap between two frames may last (milliseconds) — the default of
 * ROUTER_STREAM_IDLE_MS.
 *
 * Tens of seconds of silence is normal in a reasoning stream; more than this
 * means the upstream is hanging, not thinking.
 */
export const STREAM_IDLE_DEFAULT_MS = 180_000;

/**
 * Bring a configured limit into the allowed range.
 *
 * Zero and negative values are kept as they are: they mean "the gate is off",
 * which is a deliberate choice (the self-tests need it) and is warned about
 * wherever it is read. Anything above the ceiling is pulled down to it, so no
 * configuration can make the gate stricter than the layer below it.
 *
 * Non-finite values are decided here too, so none of them can slip through to
 * a `setTimeout` (Node clamps an out-of-range delay to 1ms, which would cut a
 * quiet stream almost immediately):
 *
 *   - `Infinity` is "too large", so it is clamped to the ceiling.
 *   - `-Infinity` is "the gate is off", the same as 0 and negatives.
 *   - `NaN` has no decidable meaning from this signature alone (it could be a
 *     bug upstream of us), so it is returned as-is and the caller decides the
 *     fallback. `idleGates` does that explicitly and warns.
 */
export function clampStreamLimit(value: number): number {
  // Infinity is the one non-finite value that is simply "too large": clamp it.
  if (value === Infinity) return STREAM_LIMIT_MAX_MS;
  // -Infinity means the gate is off, like 0 and negatives. Keep it.
  if (value === -Infinity) return value;
  // NaN has no decidable semantics here: hand it back to the caller, which
  // knows which default to fall back to (see idleGates in deliver.ts).
  if (Number.isNaN(value)) return value;
  // 0 or negative: the gate is off. Not a value to clamp.
  if (value <= 0) return value;
  return value > STREAM_LIMIT_MAX_MS ? STREAM_LIMIT_MAX_MS : value;
}

/**
 * Was this value pulled down to the ceiling?
 *
 * The write path tells the operator when this is true ("your value was
 * accepted at the ceiling") instead of silently changing what they asked
 * for. `Infinity` counts as capped (it is clamped to the ceiling);
 * `-Infinity` and `NaN` do not (they are kept / handed back, not clamped).
 */
export function streamLimitWasCapped(value: number): boolean {
  return value === Infinity || (Number.isFinite(value) && value > STREAM_LIMIT_MAX_MS);
}

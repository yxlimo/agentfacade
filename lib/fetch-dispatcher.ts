// lib/fetch-dispatcher.ts — the layer below our own stream gates.
//
// Two gates end a quiet upstream, and they must be ordered:
//
//   ours      lib/router/deliver.ts     the idle / first-frame limits
//   undici    the fetch layer           bodyTimeout (default: 300s)
//
// They are the same thing at two levels. If the lower one is stricter, it
// fires first: the client gets Node's `terminated` instead of our sentence,
// our limit setting does nothing, and the log shows a transport error rather
// than "the upstream went quiet". Production had exactly that: idle 360s
// against undici's 300s.
//
// So the lower one is derived from the upper one. There is no second magic
// number to keep in sync: FETCH_BODY_TIMEOUT_MS is STREAM_LIMIT_MAX_MS times
// 1.5, and the invariant "bodyTimeout is strictly greater than
// STREAM_LIMIT_MAX_MS" is asserted in test/stream-limits-check.ts.
//
// The whole file has exactly one caller: installFetchDispatcher(), called once
// at process start (router-proxy.ts).

import { log } from "./log.ts";
import { Agent, setGlobalDispatcher, fetch as undiciFetch } from "undici";
import { STREAM_LIMIT_MAX_MS } from "./router/stream-limits.ts";

/**
 * How long the fetch layer waits for the next byte of the body (milliseconds).
 *
 * Derived, not chosen: it has to be looser than the largest value our own
 * gate may take, otherwise the lower layer ends the stream before the upper
 * one gets a chance to say why.
 */
export const FETCH_BODY_TIMEOUT_MS = Math.ceil(STREAM_LIMIT_MAX_MS * 1.5);

/**
 * The timeouts the dispatcher is built with.
 *
 * Exported so the test can look at the numbers that are actually in force
 * instead of re-deriving them.
 */
export function fetchTimeoutOptions(): {
  connectTimeout: number;
  headersTimeout: number;
  bodyTimeout: number;
  keepAliveTimeout: number;
} {
  return {
    // Connecting is a network fact, not a stream-length question: a stuck
    // connect is a dead upstream and should be given up on quickly.
    connectTimeout: 10_000,
    // The headers of a streaming answer arrive long before the body does.
    // Node's default (300s) is the same number that used to cut the body
    // off, so it gets the same treatment: our gates decide, not this.
    headersTimeout: FETCH_BODY_TIMEOUT_MS,
    bodyTimeout: FETCH_BODY_TIMEOUT_MS,
    // Longer than the clients' own keep-alive, so a pooled connection is not
    // closed between two requests.
    keepAliveTimeout: 30_000,
  };
}

/**
 * The invariant, as a question: is the lower layer looser than the upper one?
 *
 * True means our gate always gets to fire first, so the client hears our
 * sentence instead of `terminated`.
 */
export function fetchTimeoutsAreLooserThanStreamLimit(): boolean {
  return fetchTimeoutOptions().bodyTimeout > STREAM_LIMIT_MAX_MS;
}

/**
 * Put the dispatcher in place. Call this once, at process start.
 *
 * Node's own fetch reads its dispatcher from a symbol shared with the undici
 * package, but the two may be different major versions — mixing them makes
 * the timeouts depend on which copy wins. So the global fetch is replaced with
 * undici's own, bound to the agent below: one implementation, one set of
 * timeouts, no guessing.
 */
export function installFetchDispatcher(): void {
  const agent = new Agent(fetchTimeoutOptions());
  // Anything that asks undici directly gets the same agent.
  setGlobalDispatcher(agent);
  // SAFETY: undici's fetch takes the same arguments as the global one and
  // returns the same kind of Response (status, headers, a web ReadableStream
  // body). The only difference is the extra `dispatcher` field, which the
  // global type does not know about -- so the cast is about the init object,
  // not about the behaviour.
  globalThis.fetch = ((input: any, init: any) =>
    undiciFetch(input, { ...(init ?? {}), dispatcher: agent })) as unknown as typeof globalThis.fetch;
  log.info(
    `  [FETCH] 下层超时已放宽：bodyTimeout=${FETCH_BODY_TIMEOUT_MS}ms（闸门上限 ${STREAM_LIMIT_MAX_MS}ms）`,
  );
}

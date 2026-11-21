// lib/upstream-gateway-page.ts — upstream answered with a page, not with its API.
//
// A gateway in front of an upstream can answer its model endpoint with an HTML
// error page (a CDN/ESA 405, a maintenance page, a WAF challenge). That answer
// carries no business code and no API envelope: asking the same endpoint again
// gets the same page, so it is not a transient failure and retrying it only
// holds the client until the whole attempt budget runs out.
//
// The criterion stays in this leaf module and in the one classification branch
// that consumes GatewayPageError. It must not be tied to a status or a vendor:
// "this is not the upstream's API" is the fact that decides the handling.
//
// Leaf on purpose: only the error shape, the client-facing scrub and the
// upstream-truth helpers are imported here, so both transports and routing can
// use it without pulling in either side's dependencies.

import { AuthError } from "./credential.ts";
import { scrubForClient } from "./log-scrub.ts";
import { withUpstreamBody } from "./upstream-status.ts";

/** How much of the body is inspected for an HTML opening tag. */
const HEAD_BYTES = 200;
const HTML_HEAD = /^\s*<(?:!doctype\s+html|html)(?=[\s>])/i;

/** An HTML opening tag within the first bytes says "this is a web page". */
async function startsWithHtml(response: Response): Promise<boolean> {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < HEAD_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } catch {
    return false;
  } finally {
    // The tee branch we created is not needed any more; the original response
    // still has its whole body for the caller to read and log.
    await reader.cancel().catch(() => {});
  }
  const head = new Uint8Array(Math.min(length, HEAD_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, HEAD_BYTES - at);
    head.set(chunk.subarray(0, take), at);
    at += take;
    if (at >= HEAD_BYTES) break;
  }
  return HTML_HEAD.test(new TextDecoder().decode(head));
}

/**
 * Is this non-2xx answer an HTML page instead of the upstream's API answer?
 *
 * The content type is the cheap signal; the first bytes of the body cover the
 * gateways that mislabel their error pages. Both are checked on a clone so the
 * transport can still read the raw text for the log and the client hint.
 */
export async function isGatewayPage(response: Response): Promise<boolean> {
  if (response.ok) return false;
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/html")) return true;
  return startsWithHtml(response);
}

/** The upstream's real status is kept; `status` stays the gateway's answer. */
export class GatewayPageError extends AuthError {
  readonly upstreamStatus: number;

  constructor(status: number, body: string) {
    super(`upstream answered with an HTML page (HTTP ${status})`, scrubForClient(body, 300), 502);
    this.name = "GatewayPageError";
    this.upstreamStatus = status;
    withUpstreamBody(this, body);
  }
}

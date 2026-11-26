// test/json-value-check.ts — the two narrow mouths of lib/dialect/json-value.ts
//
//   node --experimental-strip-types test/json-value-check.ts
//
// Offline: pure functions plus a fake upstream byte stream. No gateway, no real platform.
//
// jsonObjectOf carries a promise in its own comment:
//
//   "Arrays are kept: an upstream frame can be an array carrying named fields, and
//    rejecting it here would change which branch the caller takes"
//
// Nobody pinned that promise: changing the implementation to reject arrays left
// every test green. The checks below pin it — the narrow mouth itself (2) and the
// reading path over a real upstream frame (7).
//
// Covers:
//   1. a plain object goes through the narrow mouth
//   2. an array goes through it too (the promise)
//   3. scalars and null do not
//   4. jsonAt reads a path that crosses an array
//   5. a path that stops at a non-container yields undefined instead of throwing
//   6. a missing key yields undefined
//   7. end to end: a real shaped OpenAI tool_calls frame read with the reader
//      deliver.ts already uses (jsonAt), then the same frames through the real
//      dialect conversion

import fs from "node:fs";
import type { Json } from "../lib/json.ts";
import type { JsonValue } from "../lib/dialect/json-value.ts";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "json-value-"));
process.env.FACADE_DATA_DIR = tmp;

const { jsonObjectOf, jsonAt } = await import("../lib/dialect/json-value.ts");
const { readOpenAIChunks, readSseEvents } = await import("../lib/sse-stream.ts");
const { openaiStreamToAnthropic } = await import("../lib/dialect/stream.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 1. A plain object goes through
 * ------------------------------------------------------------------ */

section("1. jsonObjectOf lets a plain object through");

const plain = { a: 1 };
const plainRecord = jsonObjectOf(plain);
check("the object is not rejected", plainRecord !== null);
check("its field is readable", plainRecord?.a === 1, JSON.stringify(plainRecord?.a));
check("the same object comes back, not a copy", plainRecord === (plain as unknown));

/* ------------------------------------------------------------------ *
 * 2. An array goes through too — the promise in the comment
 * ------------------------------------------------------------------ */

section("2. jsonObjectOf lets an array through (the promise in the comment)");

const arrayValue = [{ a: 1 }];
const arrayRecord = jsonObjectOf(arrayValue);
check("the array is not rejected", arrayRecord !== null);
check("the same array comes back, not a copy", arrayRecord === (arrayValue as unknown));
const first = arrayRecord?.[0];
check(
  "the first element is readable",
  typeof first === "object" && first !== null && !Array.isArray(first) && (first as { a?: unknown }).a === 1,
  JSON.stringify(first),
);

/* ------------------------------------------------------------------ *
 * 3. Scalars and null do not
 * ------------------------------------------------------------------ */

section("3. jsonObjectOf rejects scalars and null");

for (const scalar of [null, 1, "x", true, undefined] as unknown[]) {
  check(`rejects ${JSON.stringify(scalar) ?? "undefined"}`, jsonObjectOf(scalar) === null);
}

/* ------------------------------------------------------------------ *
 * 4. jsonAt reads a path that crosses an array
 * ------------------------------------------------------------------ */

section("4. jsonAt reads a path");

check(
  "reads through the array",
  jsonAt({ a: { b: [{ c: 1 }] } } as unknown as JsonValue, "a", "b", 0, "c") === 1,
);
check(
  "indexes an array that sits at the top",
  jsonAt([{ x: 1 }] as unknown as JsonValue, 0, "x") === 1,
);

/* ------------------------------------------------------------------ *
 * 5. A path that stops at a non-container
 * ------------------------------------------------------------------ */

section("5. jsonAt stops where the path cannot go on");

let threw = false;
let stopped: JsonValue | undefined;
try {
  stopped = jsonAt({ a: 1 } as unknown as JsonValue, "a", "b", "c");
} catch {
  threw = true;
}
check("it does not throw", !threw);
check("it yields undefined", stopped === undefined, JSON.stringify(stopped));

/* ------------------------------------------------------------------ *
 * 6. A missing key
 * ------------------------------------------------------------------ */

section("6. jsonAt on a missing key");

check("a missing key yields undefined", jsonAt({ a: {} } as unknown as JsonValue, "a", "nope") === undefined);
check("a missing root yields undefined", jsonAt(undefined, "a") === undefined);

/* ------------------------------------------------------------------ *
 * 7. End to end over a real shaped OpenAI tool_calls frame
 * ------------------------------------------------------------------ */

section("7. a real tool_calls frame read with the reader deliver.ts uses");

const upstreamFrames: Json[] = [
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  },
];

const encoder = new TextEncoder();
const upstreamSse = `${upstreamFrames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
const upstreamBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(upstreamSse));
    controller.close();
  },
});

const chunks: Json[] = [];
for await (const chunk of readOpenAIChunks(upstreamBody)) chunks.push(chunk);
check("the upstream frames are read", chunks.length === 3, String(chunks.length));

const openingFrame = chunks[0] as JsonValue | undefined;
const toolName = jsonAt(openingFrame, "choices", 0, "delta", "tool_calls", 0, "function", "name");
check("the tool name is found through the arrays", toolName === "read_file", JSON.stringify(toolName));
const openingArguments = jsonAt(openingFrame, "choices", 0, "delta", "tool_calls", 0, "function", "arguments");
check("the opening frame carries empty arguments", openingArguments === "", JSON.stringify(openingArguments));

const argumentsFrame = chunks[1] as JsonValue | undefined;
const argumentsText = jsonAt(argumentsFrame, "choices", 0, "delta", "tool_calls", 0, "function", "arguments");
check("the arguments are found through the arrays", argumentsText === '{"path":"a.txt"}', JSON.stringify(argumentsText));

// The same frames through the real dialect conversion, then read back with the
// same reader: the tool call survives the conversion the router actually runs.
const anthropicFrames: string[] = [];
for await (const frame of openaiStreamToAnthropic(
  (async function* () {
    for (const chunk of chunks) yield chunk;
  })(),
  "fake-model",
)) {
  anthropicFrames.push(String(frame));
}
check("the conversion produced frames", anthropicFrames.length > 0, String(anthropicFrames.length));

const anthropicBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(anthropicFrames.join("")));
    controller.close();
  },
});
let convertedName: JsonValue | undefined;
let convertedArguments: JsonValue | undefined;
for await (const event of readSseEvents(anthropicBody)) {
  const payload = JSON.parse(event.data) as JsonValue;
  if (event.event === "content_block_start") convertedName = jsonAt(payload, "content_block", "name");
  if (event.event === "content_block_delta") convertedArguments = jsonAt(payload, "delta", "partial_json");
}
check("the tool call became a tool_use block", convertedName === "read_file", JSON.stringify(convertedName));
check(
  "the arguments survived the conversion",
  convertedArguments === '{"path":"a.txt"}',
  JSON.stringify(convertedArguments),
);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

// lib/dialect/json-value.ts — values that actually came off the wire
//
// lib/json.ts keeps its loose index signature for payloads parsed elsewhere
// New parse boundaries take JsonValue and narrow it through these helpers
// instead of scattering field assertions across call sites

/** Anything a JSON parser can return */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** A JSON object whose fields stay unknown until narrowed */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Narrow an object-like JSON value for field access
 *
 * Arrays are kept: an upstream frame can be an array carrying named fields, and
 * rejecting it here would change which branch the caller takes
 */
export function jsonObjectOf(value: unknown): JsonObject | null {
  // The single narrow mouth: after `typeof` there is no structural guarantee
  // that the object's fields are JSON values
  return value !== null && typeof value === "object" ? (value as JsonObject) : null;
}

/**
 * Safe path lookup through JSON containers
 *
 * Stops at the first value that cannot hold a field, so a missing or oddly
 * shaped upstream field yields undefined rather than throwing
 */
export function jsonAt(value: JsonValue | undefined, ...path: ReadonlyArray<string | number>): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    const record = jsonObjectOf(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

// lib/store/migrate-usage.ts — one-time migration for the request-level usage log.
//
// The usage table is created lazily by lib/usage.ts, so a database may reach
// startup with no usage_event table at all. That database gets session_name from
// CREATE TABLE later; only an existing table needs ALTER TABLE here.
//
// Both gates matter. The version gate keeps later steps from re-running an
// already-applied migration; the column probe handles databases where the column
// exists but the version was never bumped. Neither gate alone is enough.

import type { DatabaseSync } from "node:sqlite";
import { schemaVersion, setSchemaVersion } from "./migrate-platforms.ts";

/** 6 follows the platform-header migration (5); usage changes own their own number. */
const SESSION_NAME_VERSION = 6;

export function migrateUsageSessionName(db: DatabaseSync): void {
  if (schemaVersion(db) >= SESSION_NAME_VERSION) return;
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_event'")
    .get() as { name?: string } | undefined;
  if (table) {
    const columns = db.prepare("PRAGMA table_info(usage_event)").all() as { name?: string }[];
    if (!columns.some((column) => column.name === "session_name")) {
      db.exec("ALTER TABLE usage_event ADD COLUMN session_name TEXT NOT NULL DEFAULT ''");
    }
  }
  // Advance the version even when the table was absent: the column is in
  // CREATE TABLE, so a later ensureTable() produces the migrated shape.
  setSchemaVersion(db, SESSION_NAME_VERSION);
}

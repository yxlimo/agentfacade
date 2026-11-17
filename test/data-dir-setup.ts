// test/data-dir-setup.ts — set BUDDY_DATA_DIR before any store() call.
//
// ESM evaluates every static import before any top-level statement of the
// importing module. Some lib modules call store() while they are evaluated
// (lib/minimax/checkin.ts reaches store() through
// auth.ts → oauth.ts → warn-ms.ts → configNumber → getConfig → store()),
// and store() reads BUDDY_DATA_DIR when it opens the database. So a test that
// sets BUDDY_DATA_DIR in its own top-level body is always too late.
//
// The only reliable place is the first import evaluated. This module must be
// the first static import of any test that touches store()-reaching modules;
// it sets a fresh temp dir and never overrides an existing value.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.BUDDY_DATA_DIR) {
  process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "test-data-dir-"));
}
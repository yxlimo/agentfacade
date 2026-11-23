// lib/store/lock.ts — locks 表：刷新令牌的单写者锁。
//
// 从 store.ts 原样搬来。同一份刷新令牌的两个持有者会各转一次、把对方登出，
// 所以刷新前先拿这把锁；另一个写者等它，锁没了再读会话就能拿到新令牌。

import { store } from "./connection.ts";

/** A lock older than this counts as abandoned. */
const LOCK_STALE_MS = 30_000;

/** The lock could not be taken: somebody else is mid-refresh. */
export class LockUnavailableError extends Error {}

/**
 * Single writer around a refresh.
 *
 * Two holders of the same refresh token would rotate it twice and one of them
 * would be logged out, so a refresh takes this lock first. The other writer
 * waits; when the lock is gone it reads the session and finds the fresh token.
 */
export async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  let acquired = false;
  for (let i = 0; i < 3 && !acquired; i++) {
    try {
      store()
        .prepare("INSERT INTO locks (id, holder, at) VALUES (?, ?, ?)")
        .run(id, String(process.pid), Date.now());
      acquired = true;
    } catch (e) {
      const message = String((e as Error)?.message ?? "");
      if (!message.includes("UNIQUE") && !message.includes("constraint")) throw e;
      const row = store().prepare("SELECT at FROM locks WHERE id = ?").get(id) as { at?: number } | undefined;
      const age = row?.at ? Date.now() - Number(row.at) : LOCK_STALE_MS;
      if (age > LOCK_STALE_MS) {
        try {
          store().prepare("DELETE FROM locks WHERE id = ?").run(id);
        } catch {
          /* someone else won the race */
        }
        continue;
      }
      // Another writer is mid-refresh: wait for its result instead of racing it.
      await new Promise((r) => setTimeout(r, Math.min(LOCK_STALE_MS - age, 2000)));
    }
  }
  if (!acquired) {
    throw new LockUnavailableError(`could not acquire the credential lock (${id})`);
  }
  try {
    return await fn();
  } finally {
    try {
      store().prepare("DELETE FROM locks WHERE id = ?").run(id);
    } catch {
      /* already gone */
    }
  }
}

// lib/store.ts — where the credentials live: one SQLite file.
//
// Everything secret the gateway holds is in here: the sessions of the eight
// upstreams, the keys the clients authenticate with, the relay station's
// accounts, the salt the device fingerprint is derived from. The file itself
// is 0600, the same as the session files it replaces.
//
// Two more tables live beside them:
//   locks  one writer at a time, because a refresh token rotates on every
//          refresh and two writers would log each other out
//   cache  the snapshot /health serves, so it does not have to ask the
//          upstreams every time somebody looks
//
// And one that is not a secret:
//   config the settings, so the service reads them from here at startup
//          instead of from the environment, and a management panel can
//          write them
//
// Node 24 ships SQLite, so there is no native module to compile.
//
// 实现分在 lib/store/ 下（connection 建表与迁移调度、secrets、settings、cache、
// lock、migrate-*），这里只是门面：re-export，导出名与拆分前一致，调用方不用改。

import { dbPath } from "./paths.ts";

export { dbPath };
export type { SecretKind, SecretRow } from "./store/secrets.ts";
export { getSecret, setSecret, deleteSecret, listSecrets } from "./store/secrets.ts";
export type { ConfigRow } from "./store/settings.ts";
export { getConfig, setConfig, deleteConfig, listConfig } from "./store/settings.ts";
export type { Cached } from "./store/cache.ts";
export { peekCached, setCached, listCached, deleteCached } from "./store/cache.ts";
export { LockUnavailableError, withLock } from "./store/lock.ts";
export {
  store,
  closeStore,
  platformPresetRemoved,
  rememberPlatformPresetRemoved,
  forgetPlatformPresetRemoved,
} from "./store/connection.ts";
export { migrateAccountIds } from "./store/migrate-accounts.ts";
export {
  migratePlatforms,
  migrateSimulatedClients,
} from "./store/migrate-platforms.ts";

// lib/log.ts — the one log outlet for the backend, on top of winston.
//
// Leaf module: imports winston and nothing from this repo. Nearly every module
// imports log, so importing a repo module here would close a cycle.
//
// Level and format come straight from process.env, not lib/config.ts: logging
// must work before the database (which config reads) is opened.
//
// FACADE_LOG_LEVEL  debug|info|warn|error|silent — default info, anything else
//                  falls back to info
// FACADE_LOG_FORMAT json — one JSON object per line (level, message, timestamp);
//                  anything else keeps the plain format
//
// The default format is printf(i => i.message): the message is emitted byte for
// byte, with no level tag or prefix. This is deliberate — production greps the
// raw stream, e.g. `podman logs | grep '[ZCODE]'`, and any decoration would
// break those lines. Keep the tagged message text exactly as it is.

import winston from "winston";

const LEVELS = ["debug", "info", "warn", "error", "silent"];

function levelFromEnv(): string {
  const raw = process.env.FACADE_LOG_LEVEL;
  return raw && LEVELS.includes(raw) ? raw : "info";
}

const format =
  process.env.FACADE_LOG_FORMAT === "json"
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.printf((info) => String(info.message));

const logger = winston.createLogger({
  level: levelFromEnv(),
  format,
  transports: [new winston.transports.Console({ stderrLevels: ["warn", "error"] })],
});

// console takes several arguments and prints them separated by spaces; winston
// treats a second argument as metadata, which the plain format would drop. Join
// here so log.* behaves like the console.* calls it replaces.
function message(args: unknown[]): string {
  return args.map((arg) => String(arg)).join(" ");
}

export const log = {
  debug: (...args: unknown[]) => logger.debug(message(args)),
  info: (...args: unknown[]) => logger.info(message(args)),
  warn: (...args: unknown[]) => logger.warn(message(args)),
  error: (...args: unknown[]) => logger.error(message(args)),
};

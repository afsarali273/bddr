/**
 * Levelled logging.
 *
 *   ctx.log('plain info');                 // same as ctx.log.info
 *   ctx.log.debug('payload', { id: 1 });   // optional structured data
 *   ctx.log.warn('slow response');
 *   ctx.log.error('cleanup failed', err);
 *   ctx.log.image('after login', pngBytes);            // screenshot / image with a message (level info)
 *   ctx.log.warn('cart looks wrong', screenshotBuffer); // bytes as data = image attached to that log line
 *
 *   import { log } from '@bddr/runtime';   // anywhere (page objects, API clients, helpers):
 *   log.info('clicked save');              // attributed to the scenario/step currently running
 *
 * Every call becomes a `log` event (all levels, always), so NDJSON/HTML reports have everything.
 * The console reporter shows logs at or above `logLevel` (default 'warn'; CLI --log-level).
 *
 * The global `log` finds the current scenario through AsyncLocalStorage, so it works across `await`
 * and with concurrent scenarios. Outside any scenario/hook it logs at run level.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogLevel } from '@bddr/core';

export type LogFn = (message: string, data?: unknown) => void;

export interface LogImageOptions {
  level?: LogLevel;
  /** Default: sniffed from the bytes (png, jpeg, gif, webp, svg), else application/octet-stream. */
  mediaType?: string;
  name?: string;
}

export interface Logger extends LogFn {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  /** Log a message with an image/file (screenshot, chart, PDF…). */
  image(message: string, bytes: Uint8Array, options?: LogImageOptions): void;
}

export interface LogAttachment {
  mediaType: string;
  encoding: 'base64';
  body: string;
  name?: string;
  bytes: number;
}

export type LogSink = (level: LogLevel, message: string, data?: unknown, attachment?: LogAttachment) => void;

/** Best-effort media type from magic bytes. */
export function sniffMediaType(bytes: Uint8Array): string {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  const head = Buffer.from(b.subarray(0, 256)).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

function toAttachment(bytes: Uint8Array, mediaType?: string, name?: string): LogAttachment {
  return {
    mediaType: mediaType ?? sniffMediaType(bytes),
    encoding: 'base64',
    body: Buffer.from(bytes).toString('base64'),
    bytes: bytes.byteLength,
    ...(name ? { name } : {}),
  };
}

/** Errors are not JSON-friendly: keep their useful parts. */
function normaliseData(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
  return data;
}

export function createLogger(sink: LogSink): Logger {
  const at =
    (level: LogLevel): LogFn =>
    (message, data) => {
      if (data instanceof Uint8Array) sink(level, String(message), undefined, toAttachment(data));
      else sink(level, String(message), data === undefined ? undefined : normaliseData(data));
    };
  const logger = at('info') as Logger;
  logger.debug = at('debug');
  logger.info = at('info');
  logger.warn = at('warn');
  logger.error = at('error');
  logger.image = (message, bytes, options = {}) =>
    sink(options.level ?? 'info', String(message), undefined, toAttachment(bytes, options.mediaType, options.name));
  return logger;
}

const current = new AsyncLocalStorage<Logger>();
let fallback: Logger | undefined;

/** Run `fn` with `logger` as the target of the global `log`. */
export function withLogger<T>(logger: Logger, fn: () => T): T {
  return current.run(logger, fn);
}

/** Set the run-level logger used when no scenario/hook is active (the executor does this). */
export function setFallbackLogger(logger: Logger | undefined): void {
  fallback = logger;
}

const route =
  (level: LogLevel): LogFn =>
  (message, data) => {
    const target = current.getStore() ?? fallback;
    if (target) target[level](message, data);
    else if (level === 'warn' || level === 'error') process.stderr.write(`[${level}] ${message}\n`);
  };

/** Global logger: attributed to whatever scenario/step/hook is running in this async context. */
export const log: Logger = Object.assign(route('info'), {
  debug: route('debug'),
  info: route('info'),
  warn: route('warn'),
  error: route('error'),
  image: (message: string, bytes: Uint8Array, options?: LogImageOptions) => {
    const target = current.getStore() ?? fallback;
    if (target) target.image(message, bytes, options);
  },
});

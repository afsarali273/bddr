import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { BddrEvent } from '@bddr/core';
import type { Reporter, ReporterOptions } from './types.js';

/** Writes every event as one JSON line. The canonical machine-readable output. */
export function ndjsonReporter(raw: ReporterOptions = {}): Reporter {
  const outputFile = String(raw['outputFile'] ?? 'reports/bddr.ndjson');
  let stream: WriteStream | undefined;
  return {
    name: 'ndjson',
    onEvent(e: BddrEvent) {
      if (!stream) {
        mkdirSync(dirname(outputFile), { recursive: true });
        stream = createWriteStream(outputFile, { encoding: 'utf8' });
      }
      stream.write(`${JSON.stringify(e)}\n`);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        if (!stream) return resolve();
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}

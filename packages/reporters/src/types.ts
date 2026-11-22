import type { BddrEvent } from '@bddr/core';

/**
 * A reporter consumes the event stream. It must not assume anything that is not in
 * the events (that is what keeps reports identical for TS and Java runs).
 */
export interface Reporter {
  readonly name: string;
  onEvent(event: BddrEvent): void | Promise<void>;
  /** Called once after `runFinished`, to flush files. */
  close?(): Promise<void>;
}

export type ReporterOptions = Record<string, unknown>;
export type ReporterFactory = (options: ReporterOptions) => Reporter;

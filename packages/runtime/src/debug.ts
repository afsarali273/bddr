/**
 * Debug hooks (Phase 5 DX). The executor calls a DebugController at two points; everything interactive (prompt,
 * inspection, REPL) lives in the CLI. The executor only needs these two decisions.
 */
import type { Status, StepArgument } from '@bddr/core';
import type { StepContext } from './types.js';

export interface DebugStepView {
  scenario: { id: string; name: string; uri: string; line: number; tags: string[]; example?: Record<string, string> };
  step: { index: number; total: number; id: string; keyword: string; text: string; line: number; arg?: StepArgument };
  /** The scenario's step context: ctx.state, ctx.params, ctx.run, ... for inspection or evaluation. */
  ctx: StepContext;
}

export interface DebugFailureView extends DebugStepView {
  status: Status;
  error: unknown;
}

export interface DebugController {
  /**
   * Called before every step that is about to run (not for skipped steps). Resolve when the step may run.
   * Return 'quit' to skip this step; the controller is expected to have cancelled the run (AbortSignal) itself.
   */
  beforeStep?(view: DebugStepView): Promise<'run' | 'quit'>;
  /**
   * Called when a step has failed (after its own retries). Return 'retry' to run the step again (when it passes, the
   * scenario continues), or 'continue' to accept the failure.
   */
  onFailure?(view: DebugFailureView): Promise<'continue' | 'retry' | 'quit'>;
}

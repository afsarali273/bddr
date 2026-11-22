/**
 * Interactive debugger for `bddr run --debug`. Implements the runtime DebugController over a line-based prompt.
 * Commands: c(ontinue) n(ext) r(etry) s/state e <expr> h(elp) q(uit). The IO is injectable so it can be tested.
 */
import { createInterface } from 'node:readline';
import type { DebugController, DebugFailureView, DebugStepView } from '@bddr/runtime';

export interface DebugIO {
  /** Read one line (undefined at end of input). */
  ask(prompt: string): Promise<string | undefined>;
  write(text: string): void;
}

export interface DebugOptions {
  /** Pause before every step (otherwise only after failures). */
  stepMode: boolean;
  io: DebugIO;
  /** Called on 'q': cancel the run. */
  quit: () => void;
}

const HELP = `  c, continue   run on (stops again at the next failure${'' /* step mode: next step */})
  n, next       run this step, then pause again (switches on step-by-step mode)
  r, retry      (after a failure) run the failed step again
  s, state      show ctx.state, ctx.params and ctx.run
  e <expr>      evaluate an expression with ctx in scope, e.g.  e ctx.state.get('basket')
  q, quit       stop the run
`;

const preview = (v: unknown): string => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2);
    return s === undefined ? String(v) : s.length > 2000 ? `${s.slice(0, 2000)}… (${s.length} chars)` : s;
  } catch {
    return String(v);
  }
};

export function createDebugController(o: DebugOptions): DebugController {
  let stepMode = o.stepMode;
  let announced = false;

  const stateText = (v: DebugStepView): string => {
    const dump = (name: string, s: { keys(): string[]; get<T>(k: string): T }) => {
      const keys = s.keys();
      return `  ${name}: ${keys.length ? '' : '(empty)'}${keys.map((k) => `\n    ${k} = ${preview(s.get(k)).replace(/\n/g, '\n    ')}`).join('')}`;
    };
    return [dump('ctx.state', v.ctx.state), dump('ctx.run', v.ctx.run), `  ctx.params: ${preview(v.ctx.params)}`].join('\n');
  };

  const evaluate = async (v: DebugStepView, expr: string): Promise<string> => {
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...a: string[]) => (ctx: unknown) => Promise<unknown>;
      let fn: (ctx: unknown) => Promise<unknown>;
      try {
        fn = new AsyncFunction('ctx', `return (${expr});`);
      } catch {
        fn = new AsyncFunction('ctx', expr);
      }
      return preview(await fn(v.ctx));
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const header = (v: DebugStepView): string =>
    `\n${v.scenario.name}  (${v.scenario.uri}:${v.scenario.line})\n  step ${v.step.index}/${v.step.total}  ${v.step.keyword}${v.step.text}  [line ${v.step.line}]`;

  async function prompt(v: DebugStepView, failed: boolean): Promise<'run' | 'continue' | 'retry' | 'quit'> {
    if (!announced) {
      announced = true;
      o.io.write(`bddr debugger: ${failed ? 'paused after a failure' : 'step mode'}. Type h for help.\n`);
    }
    for (;;) {
      const line = (await o.io.ask(failed ? 'debug (failed)> ' : 'debug> '))?.trim();
      if (line === undefined) return 'quit'; // end of input
      const [cmd = '', ...rest] = line.split(/\s+/);
      const arg = line.slice(cmd.length).trim();
      switch (cmd) {
        case '':
        case 'c':
        case 'continue':
          stepMode = false;
          return failed ? 'continue' : 'run';
        case 'n':
        case 'next':
          stepMode = true;
          return failed ? 'continue' : 'run';
        case 'r':
        case 'retry':
          if (!failed) o.io.write('retry is only available after a failure\n');
          else return 'retry';
          break;
        case 's':
        case 'state':
          o.io.write(`${stateText(v)}\n`);
          break;
        case 'e':
        case 'eval':
          if (!arg && !rest.length) o.io.write('usage: e <expression>\n');
          else o.io.write(`${await evaluate(v, arg)}\n`);
          break;
        case 'h':
        case 'help':
        case '?':
          o.io.write(HELP);
          break;
        case 'q':
        case 'quit':
          return 'quit';
        default:
          o.io.write(`unknown command "${cmd}" (h for help)\n`);
      }
    }
  }

  return {
    async beforeStep(v) {
      if (!stepMode) return 'run';
      o.io.write(`${header(v)}\n`);
      const a = await prompt(v, false);
      if (a === 'quit') {
        o.quit();
        return 'quit';
      }
      return 'run';
    },
    async onFailure(v: DebugFailureView) {
      const e = v.error instanceof Error ? v.error : undefined;
      o.io.write(`${header(v)}\n  ${v.status.toUpperCase()}: ${e ? e.message : String(v.error)}\n${e?.stack ? `${e.stack.split('\n').slice(1, 6).join('\n')}\n` : ''}`);
      const a = await prompt(v, true);
      if (a === 'quit') {
        o.quit();
        return 'quit';
      }
      return a === 'retry' ? 'retry' : 'continue';
    },
  };
}

/** Real terminal IO. Call close() when the run ends. */
export function terminalIO(): DebugIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const queue: Array<string | undefined> = [];
  const waiters: Array<(l: string | undefined) => void> = [];
  rl.on('line', (l) => (waiters.shift() ?? ((x) => queue.push(x)))(l));
  rl.on('close', () => {
    for (const w of waiters.splice(0)) w(undefined);
    queue.push(undefined);
  });
  return {
    ask(prompt) {
      process.stdout.write(prompt);
      return queue.length ? Promise.resolve(queue.shift()) : new Promise((res) => waiters.push(res));
    },
    write: (t) => void process.stdout.write(t),
    close: () => rl.close(),
  };
}

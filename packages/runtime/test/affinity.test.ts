import { describe, expect, it } from 'vitest';
import { buildPlan, parseSpec } from '@bddr/core';
import { schedule } from '@bddr/runtime';

const src = (name: string, serial: boolean, n: number) =>
  `${serial ? '@serial\n' : ''}Feature: ${name}\n${Array.from({ length: n }, (_, i) => `  Scenario: ${name}${i}\n    Given x\n`).join('')}`;

async function slots(affinity: boolean) {
  const scenarios = [
    ...parseSpec(src('S', true, 6), 's.feature').scenarios,
    ...parseSpec(src('T', true, 4), 't.feature').scenarios,
    ...parseSpec(src('P', false, 8), 'p.feature').scenarios,
  ];
  const plan = buildPlan(scenarios, scenarios, { workers: 3 });
  const used = new Map<string, Set<string>>();
  const running = new Set<string>();
  let maxRunning = 0;
  await schedule(
    plan,
    {
      runNode: async (node, slot) => {
        const f = node.scenario.feature.name;
        if (!used.has(f)) used.set(f, new Set());
        used.get(f)!.add(slot);
        running.add(node.id);
        maxRunning = Math.max(maxRunning, running.size);
        await new Promise((r) => setTimeout(r, 2 + (node.order % 3)));
        running.delete(node.id);
        return 'passed';
      },
      skipNode: async () => {},
      stopReason: () => undefined,
    },
    { affinity },
  );
  return { used, maxRunning };
}

describe('scheduler affinity (process pool)', () => {
  it('keeps every scenario of a serial feature on one slot; others spread; all slots stay busy', async () => {
    const { used, maxRunning } = await slots(true);
    expect(used.get('S')!.size).toBe(1);
    expect(used.get('T')!.size).toBe(1);
    expect([...used.get('S')!][0]).not.toBe([...used.get('T')!][0]); // two serial features on different processes
    expect(used.get('P')!.size).toBeGreaterThan(1);
    expect(maxRunning).toBe(3);
  });

  it('without affinity (inline pool) slots are not pinned', async () => {
    const { used } = await slots(false);
    expect(used.get('P')!.size).toBeGreaterThan(1);
  });
});

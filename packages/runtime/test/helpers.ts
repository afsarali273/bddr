import { EventBus, parseSpec, type BddrEvent, type ScenarioInstance } from '@bddr/core';
import { Executor, SupportRegistry, type ExecuteOptions } from '@bddr/runtime';

/** Parse inline Gherkin (one or more features) into scenarios. */
export function scenariosOf(...features: string[]): ScenarioInstance[] {
  return features.flatMap((src, i) => {
    const spec = parseSpec(src, `f${i + 1}.feature`);
    if (spec.errors.length) throw new Error(spec.errors.map((e) => `${e.line}: ${e.message}`).join('\n'));
    return spec.scenarios;
  });
}

export async function run(
  registry: SupportRegistry,
  scenarios: ScenarioInstance[],
  options: Partial<ExecuteOptions> = {},
) {
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry, bus, ...options }).execute(scenarios);
  const events = bus.history!;
  const of = <T extends BddrEvent['type']>(type: T) => events.filter((e): e is Extract<BddrEvent, { type: T }> => e.type === type);
  const statusOf = (id: string) => result.scenarioStatuses.get(id);
  const stepStatuses = (scenarioId: string) =>
    of('stepFinished')
      .filter((e) => e.scenarioId === scenarioId)
      .map((e) => e.status);
  return { result, events, of, statusOf, stepStatuses };
}

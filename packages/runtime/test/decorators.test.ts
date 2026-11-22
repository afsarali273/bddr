import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, parseSpec } from '@bddr/core';
import {
  After,
  AfterSuite,
  Before,
  BeforeAll,
  BeforeFeature,
  BeforeRule,
  BeforeScenario,
  BeforeStep,
  BeforeSuite,
  CONTEXT,
  Executor,
  Given,
  Steps,
  Then,
  When,
  getGlobalRegistry,
  resetGlobalRegistry,
  type FeatureContext,
  type RunContext,
  type StepContext,
} from '@bddr/runtime';

afterEach(() => void resetGlobalRegistry());

async function runFeature(src: string) {
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry: getGlobalRegistry(), bus }).execute(parseSpec(src, 'f.feature').scenarios);
  return { result, events: bus.history! };
}

describe('class-based steps', () => {
  it('the package can be dynamically imported (no thenable namespace)', async () => {
    const mod = await import('@bddr/runtime');
    expect('then' in mod).toBe(false);
  });

  it('TestNG-style lifecycle on static methods: suite, feature, rule, scenario, step', async () => {
    resetGlobalRegistry();
    const log: string[] = [];
    class Lifecycle {
      @BeforeSuite() static suite(ctx: RunContext) {
        log.push(`suite ${typeof ctx.run}`);
      }
      @AfterSuite() static suiteEnd() {
        log.push('suite end');
      }
      @BeforeFeature() static feature(ctx: FeatureContext) {
        log.push(`feature ${ctx.featureInfo.name}`);
      }
      @BeforeRule() static rule(ctx: FeatureContext) {
        log.push(`rule ${ctx.rule?.name}`);
      }
      @BeforeScenario() static scenario(ctx: StepContext) {
        log.push(`scenario ${ctx.scenario.name}`);
      }
      @BeforeStep() static step(ctx: StepContext) {
        log.push(`step ${ctx.step?.text}`);
      }
    }
    void Lifecycle;
    Given('ok', () => {});
    await runFeature(`Feature: F\n  Rule: R\n    Scenario: S\n      Given ok\n`);
    expect(log).toEqual(['suite object', 'feature F', 'rule R', 'scenario S', 'step ok', 'suite end']);
    expect(getGlobalRegistry().hooksFor('run', 'before')[0]!.name).toBe('Lifecycle.suite');
  });

  it('suite/feature hooks refuse instance methods', () => {
    expect(() => {
      class Bad {
        @BeforeAll() notStatic() {}
      }
      void Bad;
    }).toThrow(/make it static/);
  });

  it('still registers plain function steps', () => {
    resetGlobalRegistry();
    Given('plain', () => {});
    expect(getGlobalRegistry().stepDefinitions).toHaveLength(1);
  });

  it('registers decorated methods and injects shared per-scenario instances', async () => {
    resetGlobalRegistry();
    const log: string[] = [];
    let created = 0;

    class Basket {
      items: string[] = [];
      constructor() {
        created++;
      }
      dispose() {
        log.push(`dispose basket(${this.items.length})`);
      }
    }

    @Steps()
    class AddSteps {
      static inject = [Basket, CONTEXT] as const;
      constructor(
        private basket: Basket,
        private ctx: StepContext,
      ) {}
      @Before({ tags: '@shop' })
      open() {
        log.push(`before ${this.ctx.scenario.name}`);
      }
      @When('I add {string}')
      add(item: string) {
        this.basket.items.push(item);
      }
    }

    @Steps()
    class CheckSteps {
      static inject = [Basket] as const;
      constructor(private basket: Basket) {}
      @Then('the basket has {int} item(s)')
      count(n: number) {
        expect(this.basket.items.length).toBe(n);
      }
      @After()
      close() {
        log.push('after');
      }
    }
    void AddSteps;
    void CheckSteps;

    const { result } = await runFeature(`Feature: x
  @shop
  Scenario: one
    When I add "apple"
    And I add "pear"
    Then the basket has 2 items
  Scenario: two
    When I add "fig"
    Then the basket has 1 item
`);
    expect(result.success).toBe(true);
    expect(created).toBe(2); // one Basket per scenario, shared by both step classes
    expect(log).toEqual(['before one', 'after', 'dispose basket(2)', 'after', 'dispose basket(1)']);
    expect(getGlobalRegistry().hookDefinitions.map((h) => h.name)).toEqual(['AddSteps.open', 'CheckSteps.close']);
  });

  it('reports dependency cycles and missing inject declarations as step failures', async () => {
    resetGlobalRegistry();
    class A {
      static inject: unknown[] = [];
    }
    class B {
      static inject = [A];
      constructor(_a: A) {}
    }
    A.inject = [B];
    class NeedsArg {
      constructor(_x: string) {}
    }
    @Steps()
    class S {
      static inject = [B] as const;
      constructor(_b: B) {}
      @Given('cycle')
      c() {}
    }
    @Steps()
    class T {
      static inject = [NeedsArg] as const;
      constructor(_n: NeedsArg) {}
      @Given('missing')
      m() {}
    }
    void S;
    void T;
    const { events } = await runFeature(`Feature: x\n  Scenario: a\n    Given cycle\n  Scenario: b\n    Given missing\n`);
    const errors = events.flatMap((e) => (e.type === 'stepFinished' && e.error ? [e.error.message] : []));
    expect(errors[0]).toMatch(/Dependency cycle: S -> B -> A -> B/);
    expect(errors[1]).toMatch(/NeedsArg has 1 constructor parameter\(s\) but declares 0/);
  });
});

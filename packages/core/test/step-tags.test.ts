import { describe, expect, it } from 'vitest';
import { extractStepTags, parseDuration, parseSpec } from '@bddr/core';

describe('step-level tags', () => {
  it('strips recognised trailing tags and parses options', () => {
    expect(extractStepTags('the order is "SHIPPED" @retry:5 @delay:2s @backoff:1.5 @timeout:30s')).toEqual({
      text: 'the order is "SHIPPED"',
      tags: [
        { name: '@retry:5', key: 'retry', value: '5' },
        { name: '@delay:2s', key: 'delay', value: '2s' },
        { name: '@backoff:1.5', key: 'backoff', value: '1.5' },
        { name: '@timeout:30s', key: 'timeout', value: '30s' },
      ],
      run: { retry: 5, delayMs: 2000, backoff: 1.5, timeoutMs: 30000 },
      errors: [],
    });
    expect(extractStepTags('I create user "u-{{i}}" @repeat:100 @concurrency:10').run).toEqual({ repeat: 100, concurrency: 10 });
  });

  it('leaves emails, quoted @words and unknown trailing tags in the text', () => {
    expect(extractStepTags('I log in as ann@example.com').text).toBe('I log in as ann@example.com');
    expect(extractStepTags('I mention "@admin"').text).toBe('I mention "@admin"');
    expect(extractStepTags('I ping @team @retry:2').text).toBe('I ping @team');
  });

  it('validates values and combinations', () => {
    expect(extractStepTags('x @repeat:0').errors).toEqual(['@repeat needs a whole number >= 1 (got "0")']);
    expect(extractStepTags('x @retry:2 @repeat:3').errors).toEqual(['Use either @repeat or @retry on a step, not both']);
    expect(extractStepTags('x @concurrency:3').errors).toEqual(['@concurrency only applies together with @repeat']);
    expect(extractStepTags('x @retry:1 @delay:soon').errors).toEqual(['"soon" is not a duration (use e.g. 500ms, 2s, 1m)']);
    expect(parseDuration('1m')).toBe(60000);
    expect(parseDuration('250')).toBe(250);
  });

  it('parser applies tags to steps, scenario @stepRetry defaults, and reports errors with lines', () => {
    const spec = parseSpec(
      `Feature: T
  @stepRetry:2 @stepTimeout:5s
  Scenario: s
    Given a @repeat:3
    When b @retry:1
    Then c
    And d @backoff:2
`,
      't.feature',
    );
    const [a, b, c] = spec.scenarios[0]!.steps;
    expect(a).toMatchObject({ text: 'a', run: { repeat: 3, timeoutMs: 5000 } }); // @repeat drops the scenario retry
    expect(b!.run).toEqual({ retry: 1, timeoutMs: 5000 });
    expect(c!.run).toEqual({ retry: 2, timeoutMs: 5000 });
    expect(spec.errors).toEqual([{ uri: 't.feature', line: 7, message: '@backoff only applies together with @retry (step "d @backoff:2")' }]);
  });
});

/** Errors the app driver throws. The runtime classifies failures by these types. */

export interface ElementSummary {
  role: string;
  name?: string;
  label?: string;
  testId?: string;
}

export interface Selector {
  role?: string;
  name?: string;
  label?: string;
  testId?: string;
}

/** An element the code asked for is not on the current screen. Carries what IS on the screen. */
export class ElementNotFound extends Error {
  override name = 'ElementNotFound';
  constructor(
    readonly selector: Selector,
    readonly available: ElementSummary[],
    readonly screen: string,
  ) {
    super(`No element matches ${JSON.stringify(selector)} on ${screen}`);
  }
}

/** A route the code asked for does not exist. Carries the routes that do. */
export class RouteNotFound extends Error {
  override name = 'RouteNotFound';
  constructor(
    readonly route: string,
    readonly routes: { path: string; title: string }[],
  ) {
    super(`No route ${route}`);
  }
}

/** The code called an API method that does not exist. Carries the methods that do. */
export class MethodNotFound extends Error {
  override name = 'MethodNotFound';
  constructor(
    readonly method: string,
    readonly available: string[],
  ) {
    super(`api.${method} is not a function`);
  }
}

/** Network or infrastructure trouble: retry, never heal. */
export class EnvironmentError extends Error {
  override name = 'EnvironmentError';
}

/** A check's expectation did not hold. */
export class AssertionError extends Error {
  override name = 'AssertionError';
  constructor(
    message: string,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(message);
  }
}

/** The compiled code broke the approved contract (unknown, repeated or missing check). */
export class ContractError extends Error {
  override name = 'ContractError';
}

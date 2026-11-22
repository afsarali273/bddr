# bddr

A test runner for BDD scenarios. Gherkin specs, with groups, dependencies between scenarios, locks, flaky-test reporting,
quarantine, CI sharding and living documentation. Use it with Playwright, Selenium, axios or any other library.

```bash
npm i -D bddr
npx bddr
```

This package installs the `bddr` command together with `@bddr/core`, `@bddr/runtime` and `@bddr/reporters`.
Add a plugin when you need one: `@bddr/playwright`, `@bddr/selenium` or `@bddr/axios`.

Documentation: https://afsarali273.github.io/bddr/ · Source: https://github.com/afsarali273/bddr

License: MIT

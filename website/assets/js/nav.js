/*
 * The docs sidebar, for every page. Edit this file (not the HTML pages) to add or rename a page.
 *   href:  path from the site root
 *   ready: false = planned; shown greyed out, not linked, and skipped by Previous/Next
 * Order here is the reading order used by the Previous/Next links.
 */
window.BDDR_NAV = [
  {
    title: 'Introduction',
    items: [
      { title: 'Why bddr', href: 'docs/why-bddr.html', ready: true },
      { title: 'Getting started', href: 'docs/getting-started.html', ready: true },
      { title: 'Your first project', href: 'docs/first-project.html', ready: true },
      { title: 'Coming from Cucumber.js', href: 'docs/from-cucumber.html', ready: true },
      { title: 'Architecture', href: 'docs/architecture.html', ready: true },
    ],
  },
  {
    title: 'Writing tests',
    items: [
      { title: 'Feature files', href: 'docs/feature-files.html', ready: true },
      { title: 'Step definitions', href: 'docs/steps.html', ready: true },
      { title: 'Parameter types', href: 'docs/parameter-types.html', ready: true },
      { title: 'Data tables and doc strings', href: 'docs/data-tables.html', ready: true },
      { title: 'Data files (CSV, JSON, Excel)', href: 'docs/data-files.html', ready: true },
      { title: 'Hooks', href: 'docs/hooks.html', ready: true },
      { title: 'Fixtures and inject()', href: 'docs/fixtures.html', ready: true },
      { title: 'Class steps and page objects', href: 'docs/class-steps.html', ready: true },
    ],
  },
  {
    title: 'Running',
    items: [
      { title: 'Command line', href: 'docs/cli.html', ready: true },
      { title: 'Configuration', href: 'docs/configuration.html', ready: true },
      { title: 'Profiles and --set', href: 'docs/profiles.html', ready: true },
      { title: 'Tags and selection', href: 'docs/tags.html', ready: true },
      { title: 'Debugging and watch mode', href: 'docs/debugging.html', ready: true },
    ],
  },
  {
    title: 'Orchestration',
    items: [
      { title: 'Groups', href: 'docs/groups.html', ready: true },
      { title: 'Dependencies', href: 'docs/dependencies.html', ready: true },
      { title: 'Serial features', href: 'docs/serial-features.html', ready: true },
      { title: 'Locks and priority', href: 'docs/locks.html', ready: true },
      { title: 'Retries and flaky tests', href: 'docs/retries.html', ready: true },
      { title: 'Worker processes', href: 'docs/process-pool.html', ready: true },
      { title: 'Sharding in CI', href: 'docs/sharding.html', ready: true },
    ],
  },
  {
    title: 'Reports',
    items: [
      { title: 'Reporters', href: 'docs/reporters.html', ready: true },
      { title: 'HTML report', href: 'docs/html-report.html', ready: true },
      { title: 'Living documentation', href: 'docs/living-docs.html', ready: true },
    ],
  },
  {
    title: 'Plugins',
    items: [
      { title: 'How plugins work', href: 'docs/plugins.html', ready: true },
      { title: 'Playwright', href: 'docs/playwright.html', ready: true },
      { title: 'Selenium', href: 'docs/selenium.html', ready: true },
      { title: 'axios (API testing)', href: 'docs/axios.html', ready: true },
      { title: 'UI and API in one scenario', href: 'docs/mixed.html', ready: true },
      { title: 'Writing your own plugin', href: 'docs/writing-plugins.html', ready: true },
    ],
  },
  {
    title: 'Reference',
    items: [
      { title: 'CLI options', href: 'docs/reference-cli.html', ready: true },
      { title: 'Config options', href: 'docs/reference-config.html', ready: true },
      { title: 'Runtime API', href: 'docs/reference-api.html', ready: true },
      { title: 'Event stream (NDJSON)', href: 'docs/reference-events.html', ready: true },
    ],
  },
  {
    title: 'About these docs',
    items: [{ title: 'Theme and components', href: 'docs/components.html', ready: true }],
  },
];

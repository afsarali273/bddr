import {
  After,
  AfterAll,
  AfterFeature,
  AfterGroup,
  AfterStep,
  BeforeAll,
  BeforeFeature,
  BeforeGroup,
  BeforeStep,
} from '@bddr/runtime';
import '@bddr/axios'; // types for ctx.api / ctx.axios / ctx.newApi
import '@bddr/playwright'; // types for ctx.page / ctx.request / inject('page'); the plugin itself is in bddr.config.ts
import { requiredParam } from './world.js';

BeforeAll((ctx) => {
  ctx.run.set('suiteStartedAt', new Date().toISOString());
  ctx.log.info('Starting Playwright showcase', {
    ui: requiredParam(ctx, 'uiBaseUrl'),
    api: requiredParam(ctx, 'apiBaseUrl'),
    pool: 'process',
  });
});

AfterAll((ctx) => {
  ctx.log.info('Playwright showcase finished', { startedAt: ctx.run.get<string>('suiteStartedAt') });
});

BeforeGroup((ctx) => ctx.log.info(`Group ${ctx.groupName} started`));
AfterGroup((ctx) => ctx.log.info(`Group ${ctx.groupName} finished`));

BeforeFeature((ctx) => {
  ctx.feature.set('startedAt', Date.now());
  ctx.log.debug(`Feature started: ${ctx.featureInfo.name}`);
});

AfterFeature((ctx) => {
  ctx.log.debug(`Feature finished: ${ctx.featureInfo.name}`, {
    durationMs: Date.now() - ctx.feature.get<number>('startedAt'),
  });
});

After('@capture', async (ctx) => {
  const screenshot = await ctx.page.screenshot({ fullPage: true });
  ctx.attach(screenshot, 'image/png', `${ctx.scenario.id}.png`);
});

BeforeStep({ eachAttempt: true }, (ctx) => {
  ctx.log.debug(`Step attempt ${ctx.step?.attempt ?? 1}: ${ctx.step?.text ?? 'hook'}`);
});

AfterStep({ eachAttempt: true }, (ctx) => {
  ctx.log.debug(`Step attempt finished: ${ctx.step?.text ?? 'hook'}`);
});

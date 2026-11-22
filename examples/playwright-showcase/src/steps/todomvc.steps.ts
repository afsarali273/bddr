import { Given, Then, When, type DataTable } from '@bddr/runtime';
import { TodoMvcPage } from '../pages/todomvc.page.js';
import { requiredParam } from '../support/world.js';

Given('the TodoMVC application is open', async (ctx) => {
  await new TodoMvcPage(ctx.page).open(requiredParam(ctx, 'todoBaseUrl'));
});

Given('TodoMVC contains items {string} and {string}', async (ctx, first: string, second: string) => {
  await new TodoMvcPage(ctx.page).addTodos([first, second]);
});

Given('TodoMVC contains items {string}, {string} and {string}', async (ctx, first: string, second: string, third: string) => {
  await new TodoMvcPage(ctx.page).addTodos([first, second, third]);
});

When('I add TodoMVC item {string}', async (ctx, title: string) => {
  await new TodoMvcPage(ctx.page).addTodo(title);
});

When('I add these TodoMVC items:', async (ctx, table: DataTable) => {
  await new TodoMvcPage(ctx.page).addTodos(table.hashes().map((row) => row['title'] ?? ''));
});

When('I complete TodoMVC item {string}', async (ctx, title: string) => {
  await new TodoMvcPage(ctx.page).complete(title);
});

When('I delete TodoMVC item {string}', async (ctx, title: string) => {
  await new TodoMvcPage(ctx.page).delete(title);
});

When('I select TodoMVC filter {string}', async (ctx, filter: string) => {
  await new TodoMvcPage(ctx.page).selectFilter(filter);
});

When('I clear completed TodoMVC items', async (ctx) => {
  await new TodoMvcPage(ctx.page).clearCompleted();
});

When('I mark all TodoMVC items complete', async (ctx) => {
  await new TodoMvcPage(ctx.page).markAllComplete();
});

When('I rename TodoMVC item {string} to {string}', async (ctx, current: string, next: string) => {
  await new TodoMvcPage(ctx.page).rename(current, next);
});

When('I reload TodoMVC', async (ctx) => {
  await new TodoMvcPage(ctx.page).reload();
});

Then('TodoMVC displays {int} todo items', async (ctx, expected: number) => {
  await ctx.expect(new TodoMvcPage(ctx.page).items).toHaveCount(expected);
});

Then('TodoMVC displays 1 todo item', async (ctx) => {
  await ctx.expect(new TodoMvcPage(ctx.page).items).toHaveCount(1);
});

Then('TodoMVC displays {int} visible todo items', async (ctx, expected: number) => {
  await ctx.expect(new TodoMvcPage(ctx.page).visibleItems).toHaveCount(expected);
});

Then('TodoMVC displays {int} completed items', async (ctx, expected: number) => {
  await ctx.expect(new TodoMvcPage(ctx.page).completedItems).toHaveCount(expected);
});

Then('TodoMVC contains item {string}', async (ctx, title: string) => {
  await ctx.expect(new TodoMvcPage(ctx.page).item(title)).toHaveCount(1);
});

Then('TodoMVC does not contain item {string}', async (ctx, title: string) => {
  await ctx.expect(new TodoMvcPage(ctx.page).item(title)).toHaveCount(0);
});

Then('TodoMVC item {string} is completed', async (ctx, title: string) => {
  await ctx.expect(new TodoMvcPage(ctx.page).item(title)).toHaveClass(/completed/);
});

Then('the TodoMVC counter says {string}', async (ctx, expected: string) => {
  await ctx.expect(new TodoMvcPage(ctx.page).counter).toHaveText(expected);
});

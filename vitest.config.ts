import { defineConfig, type Plugin } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Vite 8 transpiles TypeScript with oxc, which does not lower TC39 standard decorators yet.
 * Files that use decorators are pre-compiled with the TypeScript compiler (same output as `tsc`).
 * Remove this plugin once oxc supports standard decorators.
 */
function tc39Decorators(): Plugin {
  return {
    name: 'bddr:tc39-decorators',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?ts$/.test(id) || id.includes('node_modules') || !/^\s*@\w+\(/m.test(code)) return null;
      const out = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: false },
      });
      return { code: out.outputText, map: null };
    },
  };
}

// Tests run against the TypeScript sources directly, so `npm test` needs no build.
export default defineConfig({
  plugins: [tc39Decorators()],
  resolve: {
    alias: {
      '@bddr/core': src('core'),
      '@bddr/runtime': src('runtime'),
      '@bddr/reporters': src('reporters'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'conformance/**/*.test.ts'],
  },
});

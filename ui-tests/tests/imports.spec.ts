// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  KERNELS,
  createNotebook,
  getOutputs,
  openKernelSettings,
  runCode,
  setKernelSetting
} from './utils';

const STDERR = 'application/vnd.jupyter.stderr';

// A module written in its URL, which needs no network
const MODULE = 'data:text/javascript,export const answer = 42';

// A module of the fake CDN of the test site: build.py copies
// ui-tests/fixtures/fake-cdn into the site
const FIXTURE = 'imports-fixture/index.js';

/**
 * The lines of the error shown in the outputs of a cell.
 */
async function getErrorLines(
  page: IJupyterLabPageFixture,
  index: number
): Promise<string[]> {
  const outputs = await getOutputs(page, index, STDERR);
  await expect(outputs).toHaveCount(1);
  return ((await outputs.textContent()) ?? '').split('\n');
}

// These tests load packages from the jsDelivr CDN
for (const kernel of KERNELS) {
  test.describe(`Imports (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Import npm packages by name', async ({ page }) => {
      await runCode(
        page,
        "import { capitalize, words } from 'lodash-es';\nimport * as d3 from 'd3-array@3';"
      );

      let index = await runCode(page, 'capitalize("javascript")');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'Javascript'"
      ]);

      index = await runCode(
        page,
        'd3.sum(words("one two three"), w => w.length)'
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['11']);
    });

    test('Import modules from a URL', async ({ page }) => {
      const index = await runCode(
        page,
        [
          "const { default: dayjs } = await import('https://cdn.jsdelivr.net/npm/dayjs@1.11.13/+esm');",
          'dayjs("2026-10-11").format("DD/MM/YYYY")'
        ].join('\n')
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'11/10/2026'"
      ]);
    });
  });
}

// These tests need no network
for (const kernel of KERNELS) {
  test.describe(`ES module imports (${kernel.displayName})`, () => {
    test('Show a SyntaxError for a name the module does not export', async ({
      page
    }) => {
      await createNotebook(page, kernel);
      let index = await runCode(
        page,
        `import { answer, nope } from '${MODULE}';`
      );
      let lines = await getErrorLines(page, index);
      const source = lines[1];
      expect(lines[0]).toBe('In[1]:1');
      expect(lines[2].indexOf('^')).toBe(source.indexOf('nope'));
      expect(lines).toContain(
        `SyntaxError: The requested module '${MODULE}' does not provide an export named 'nope'`
      );

      // Like an ES module, the import binds nothing
      index = await runCode(page, 'typeof answer');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'undefined'"
      ]);

      index = await runCode(page, `import fortyTwo from '${MODULE}';`);
      lines = await getErrorLines(page, index);
      expect(lines).toContain(
        `SyntaxError: The requested module '${MODULE}' does not provide an export named 'default'`
      );
    });

    test('Import package names with import(), like the import statements', async ({
      page
    }) => {
      await page.goto('lab/index.html');
      const form = await openKernelSettings(page);
      await setKernelSetting(page, form, 'CDN base URL', 'fake-cdn/');
      await createNotebook(page, kernel, { open: false });

      let index = await runCode(
        page,
        `const { greet } = await import('${FIXTURE}');\ngreet('import()')`
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'Hello, import()!'"
      ]);

      // A source computed when the cell runs, in a function
      index = await runCode(
        page,
        [
          `const source = '${FIXTURE}';`,
          'async function load() {',
          'return import(source);',
          '}',
          'const fixture = await load();',
          'fixture.default'
        ].join('\n')
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'imports fixture'"
      ]);

      // The import statement loads the same module
      index = await runCode(
        page,
        `import * as statement from '${FIXTURE}';\nstatement === fixture`
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['true']);
    });

    test('Import JSON modules and string names', async ({ page }) => {
      await createNotebook(page, kernel);
      let index = await runCode(
        page,
        "import config from 'data:application/json,{\"answer\":42}' with { type: 'json' };\nconfig.answer"
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['42']);

      index = await runCode(
        page,
        'import { "kebab-name" as kebab } from \'data:text/javascript,const value = 1; export { value as "kebab-name" }\';\nkebab'
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['1']);
    });

    test('Suggest import instead of require()', async ({ page }) => {
      await createNotebook(page, kernel);
      const index = await runCode(page, "const _ = require('lodash');");
      const lines = await getErrorLines(page, index);
      expect(lines).toContain(
        "ReferenceError: require() is not available, the cells run like ES modules: use import x from 'lodash' or await import('lodash') instead"
      );
    });
  });
}

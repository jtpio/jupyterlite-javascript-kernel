// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import { KERNELS, createNotebook, runCode } from './utils';

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

// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import { KERNELS, createNotebook, runCode } from './utils';

/**
 * Click in the editor of a cell, and type some code.
 */
async function typeInCell(
  page: IJupyterLabPageFixture,
  index: number,
  code: string
): Promise<void> {
  const input = await page.notebook.getCellInputLocator(index);
  await input!.click();
  await page.keyboard.type(code);
}

for (const kernel of KERNELS) {
  test.describe(`Editor (${kernel.displayName})`, () => {
    test('Complete the names defined in the kernel', async ({ page }) => {
      await createNotebook(page, kernel);
      const index = await runCode(page, 'const javascriptKernelAnswer = 42;');

      await typeInCell(page, index + 1, 'javascriptKer');
      await page.keyboard.press('Tab');
      const item = page.locator('.jp-Completer-item');
      await expect(item).toHaveCount(1);
      await expect(item.locator('.jp-Completer-match')).toHaveText(
        'javascriptKernelAnswer'
      );
      await page.keyboard.press('Enter');
      await expect(
        (await page.notebook.getCellInputLocator(index + 1))!.locator(
          '.cm-content'
        )
      ).toHaveText('javascriptKernelAnswer');
    });

    test('Complete the properties of objects', async ({ page }) => {
      await createNotebook(page, kernel);
      const index = await runCode(page, 'const point = { x: 1, y: 2, z: 3 };');

      await typeInCell(page, index + 1, 'point.');
      await page.keyboard.press('Tab');
      // The own properties come first
      const matches = page.locator('.jp-Completer-item .jp-Completer-match');
      await expect(matches.nth(0)).toHaveText('x');
      await expect(matches.nth(1)).toHaveText('y');
      await expect(matches.nth(2)).toHaveText('z');
      await expect(matches.nth(3)).toHaveText('__defineGetter__');

      await matches.nth(1).click();
      await page.keyboard.press('Shift+Enter');
      await page.notebook.waitForRun(index + 1);
      expect(await page.notebook.getCellTextOutput(index + 1)).toEqual(['2']);
    });

    test('Show the documentation in the contextual help', async ({ page }) => {
      const name = await createNotebook(page, kernel);
      const index = await runCode(
        page,
        'function greet(name) { return `Hello ${name}`; }'
      );

      await page.menu.clickMenuItem('Help>Show Contextual Help');
      await expect(
        page.getByRole('tab', { name: 'Contextual Help' })
      ).toBeVisible();

      // Go back to the notebook
      await page.notebook.activate(name);
      await typeInCell(page, index + 1, 'greet');
      const help = page.locator('.jp-Inspector-content');
      await expect(help).toContainText('function greet(name)');
      await expect(help).toContainText('return `Hello ${name}`');
    });
  });
}

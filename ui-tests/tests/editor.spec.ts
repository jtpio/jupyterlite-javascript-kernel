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
      await expect(matches.nth(3)).toHaveText('constructor');

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

    test('Complete the methods of literals', async ({ page }) => {
      await createNotebook(page, kernel);

      await typeInCell(page, 0, '"hello".toUpp');
      await page.keyboard.press('Tab');
      const item = page.locator('.jp-Completer-item');
      await expect(item).toHaveCount(1);
      await expect(item.locator('.jp-Completer-match')).toHaveText(
        'toUpperCase'
      );
      await page.keyboard.press('Enter');
      await page.keyboard.type('()');
      await page.keyboard.press('Shift+Enter');
      await page.notebook.waitForRun(0);
      expect(await page.notebook.getCellTextOutput(0)).toEqual(["'HELLO'"]);
    });

    test('Show the types of the completions', async ({ page }) => {
      await createNotebook(page, kernel);
      const index = await runCode(
        page,
        [
          'class ShapeClass {}',
          'function ShapeArea() {}',
          'const ShapeCount = 3;'
        ].join('\n')
      );

      await typeInCell(page, index + 1, 'Shape');
      await page.keyboard.press('Tab');
      const items = page.locator('.jp-Completer-item');
      const typeOf = (name: string) =>
        items.filter({ hasText: name }).locator('.jp-Completer-typeExtended');
      await expect(typeOf('ShapeClass')).toHaveText('class');
      await expect(typeOf('ShapeArea')).toHaveText('function');
      await expect(typeOf('ShapeCount')).toHaveText('property');
    });

    test('Show the JSDoc, MDN pages and suggestions in the contextual help', async ({
      page
    }) => {
      const name = await createNotebook(page, kernel);
      const index = await runCode(
        page,
        [
          '/**',
          ' * Add two numbers.',
          ' * @param {number} a - The first number',
          ' * @param {number} b - The second number',
          ' */',
          'function addNumbers(a, b) { return a + b; }'
        ].join('\n')
      );

      await page.menu.clickMenuItem('Help>Show Contextual Help');
      await page.notebook.activate(name);
      await typeInCell(page, index + 1, 'addNumbers');
      const help = page.locator('.jp-Inspector-content');
      await expect(help).toContainText('Signature: addNumbers(a, b)');
      await expect(help).toContainText('Docstring: Add two numbers.');
      await expect(help).toContainText('@param {number} b - The second number');

      // The built-in functions link to their MDN page
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('Math.max');
      await expect(help).toContainText('Signature: Math.max(…)');
      await expect(
        help.getByRole('link', {
          name: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/max'
        })
      ).toBeVisible();

      // The names which are not defined get suggestions
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('addNumber');
      await expect(help).toContainText(
        /'addNumber' is not defined\. Did you mean: .*addNumbers\?/
      );
    });

    test('Document _ and _error in the contextual help', async ({ page }) => {
      const name = await createNotebook(page, kernel);
      const index = await runCode(page, '21 * 2');

      await page.menu.clickMenuItem('Help>Show Contextual Help');
      await page.notebook.activate(name);
      await typeInCell(page, index + 1, '_');
      const help = page.locator('.jp-Inspector-content');
      await expect(help).toContainText('Value:     42');
      await expect(help).toContainText(
        'Docstring: The result of the last cell which showed one'
      );

      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('_error');
      await expect(help).toContainText(
        'Docstring: The last error thrown by a cell'
      );

      // They are not suggested for the undefined names
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('parse_error');
      await expect(help).toHaveText(
        "'parse_error' is not defined. Did you mean: Error?"
      );
    });
  });
}

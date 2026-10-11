// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import { KERNELS, createNotebook, getOutputs, runCode } from './utils';

for (const kernel of KERNELS) {
  test.describe(`Execution (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Show the value of the last expression', async ({ page }) => {
      let index = await runCode(page, '1 + 2 + 3');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['6']);

      index = await runCode(page, '"Hello, " + "JavaScript!"');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'Hello, JavaScript!'"
      ]);

      // A semicolon at the end hides the value
      index = await runCode(page, '1 + 2 + 3;');
      expect(await page.notebook.getCellTextOutput(index)).toBeNull();
    });

    test('Keep declarations across cells', async ({ page }) => {
      await runCode(
        page,
        [
          'let greeting = "Hello";',
          'function greet(name) { return `${greeting}, ${name}!`; }',
          'class Point { constructor(x, y) { this.x = x; this.y = y; } }'
        ].join('\n')
      );

      let index = await runCode(
        page,
        'greet("World") + " " + new Point(3, 4).y'
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'Hello, World! 4'"
      ]);

      // Declarations can be run again, and functions see the new values
      await runCode(page, 'let greeting = "Hi";');
      index = await runCode(page, 'greet("again")');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'Hi, again!'"
      ]);
    });

    test('Keep declarations named like the globals of the page', async ({
      page
    }) => {
      // `status` is a global of the page in the iframe kernel
      await runCode(page, "let status = 'idle';\nstatus = 'done';");
      let index = await runCode(page, 'status');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(["'done'"]);

      // The declaration is kept when a later line throws
      await runCode(page, "let status = 'set';\nthrow new Error('later')");
      index = await runCode(page, 'status');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(["'set'"]);
    });

    test('Await promises at the top level', async ({ page }) => {
      const index = await runCode(
        page,
        'await new Promise(resolve => setTimeout(() => resolve("done"), 500))'
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(["'done'"]);
    });

    test('Write the console output to the streams', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'console.log("log", 1, [2]);',
          'console.info("info");',
          'console.error("error");',
          'console.warn("warn");'
        ].join('\n')
      );

      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['log 1 [ 2 ]\ninfo\n']);
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stderr')
      ).toHaveText(['error\nwarn\n']);
    });

    test('Show runtime errors', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'function fail() {',
          'throw new TypeError("Something went wrong");',
          '}',
          'fail()'
        ].join('\n')
      );

      const outputs = await getOutputs(page, index);
      await expect(outputs).toHaveCount(1);
      await expect(outputs).toContainText('TypeError: Something went wrong');
      await expect(outputs).toContainText('at fail');
    });

    test('Show syntax errors', async ({ page }) => {
      const index = await runCode(page, 'let = 1');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "In[1]:1\nlet = 1\n^\n\nSyntaxError: The keyword 'let' is reserved"
      ]);
    });

    test('Show object literals', async ({ page }) => {
      const index = await runCode(
        page,
        '({ language: "JavaScript", year: 1995 })'
      );

      const json = (await getOutputs(page, index)).and(
        page.locator('.jp-RenderedJSON')
      );
      await expect(json).toContainText('language');
      await expect(json).toContainText('"JavaScript"');
      await expect(json).toContainText('1995');
    });
  });
}

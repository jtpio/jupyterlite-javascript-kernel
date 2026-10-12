// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import {
  KERNELS,
  WORKER_KERNEL,
  createNotebook,
  getOutputs,
  runCode
} from './utils';

const STDOUT = 'application/vnd.jupyter.stdout';
const STDERR = 'application/vnd.jupyter.stderr';

for (const kernel of KERNELS) {
  test.describe(`Output (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Print many lines quickly', async ({ page }) => {
      const start = Date.now();
      const index = await runCode(
        page,
        'for (let i = 0; i < 10000; i++) console.log("line", i)'
      );
      const stdout = await getOutputs(page, index, STDOUT);
      await expect(stdout).toContainText('line 9999');
      // One message per console.log took about 20 s in the iframe
      expect(Date.now() - start).toBeLessThan(5000);

      // Nothing is lost or reordered
      const lines = (await stdout.textContent())!.trimEnd().split('\n');
      expect(lines).toHaveLength(10000);
      expect(lines[0]).toBe('line 0');
      expect(lines[5000]).toBe('line 5000');
      expect(lines[9999]).toBe('line 9999');
    });

    test('Keep stdout and stderr interleaved', async ({ page }) => {
      const index = await runCode(
        page,
        'for (let i = 0; i < 3; i++) { console.log("out" + i); console.error("err" + i); }'
      );

      await expect(await getOutputs(page, index)).toHaveText([
        'out0\n',
        'err0\n',
        'out1\n',
        'err1\n',
        'out2\n',
        'err2\n'
      ]);
    });

    test('Keep the order of streams and rich outputs', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log("a"); display.html("<b>b</b>"); console.log("c"); 42'
      );

      const outputs = await getOutputs(page, index);
      await expect(outputs).toHaveText(['a\n', 'b', 'c\n', '42']);
      await expect(outputs.nth(0)).toHaveAttribute('data-mime-type', STDOUT);
      await expect(outputs.nth(1)).toHaveAttribute(
        'data-mime-type',
        'text/html'
      );
      await expect(outputs.nth(2)).toHaveAttribute('data-mime-type', STDOUT);
    });

    test('Show the output printed before an error', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log("before"); throw new Error("boom")'
      );

      const outputs = await getOutputs(page, index);
      await expect(outputs).toHaveCount(2);
      await expect(outputs.nth(0)).toHaveText('before\n');
      await expect(outputs.nth(1)).toContainText('Error: boom');
    });

    test('Print after the cell finished', async ({ page }) => {
      const index = await runCode(
        page,
        'setTimeout(() => console.log("later"), 200)'
      );

      // Nothing else sends the pending text
      await expect(await getOutputs(page, index, STDOUT)).toContainText(
        'later'
      );
    });

    test('Print the outputs of a timer in its cell', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'let ticks = 0;',
          'let last = Infinity;',
          'const timer = setInterval(() => {',
          'console.log(`tick ${++ticks}`);',
          'if (ticks === last) {',
          'clearInterval(timer);',
          'throw new Error("late");',
          '}',
          '}, 100);'
        ].join('\n')
      );
      // Stop the interval 3 ticks after this cell
      const later = await runCode(
        page,
        'last = ticks + 3;\nconsole.log(`later ${ticks}`);'
      );
      const [text] = await page.notebook.getCellTextOutput(later);
      const ticks = Number(/later (\d+)/.exec(text)![1]);

      // The interval keeps printing in its cell, with its error
      const outputArea = await page.notebook.getCellOutputLocator(index);
      await expect(outputArea!).toContainText(`tick ${ticks + 3}`);
      await expect(await getOutputs(page, index, STDERR)).toContainText(
        'Uncaught Error: late'
      );
      await expect(await getOutputs(page, later)).toHaveText([
        `later ${ticks}\n`
      ]);
    });

    test('Clear with wait', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log("a"); clearOutput(true); console.log("b")'
      );

      await expect(await getOutputs(page, index)).toHaveText(['b\n']);
    });

    test('Limit the output of a cell', async ({ page }) => {
      // The errors thrown later go to the console of the browser
      const uncaught = page.waitForEvent('console', {
        predicate: message =>
          message.type() === 'error' && message.text().includes('late')
      });
      // 6 prints of 10,000 lines of 100 characters, over the limit of
      // 5,000,000 characters
      const index = await runCode(
        page,
        [
          'const block = ("x".repeat(99) + "\\n").repeat(10000);',
          'for (let i = 0; i < 6; i++) console.log(block);',
          'console.log("hidden");',
          'setTimeout(() => { throw new Error("late"); }, 100);'
        ].join('\n')
      );

      const outputArea = await page.notebook.getCellOutputLocator(index);
      await expect(await getOutputs(page, index, STDERR)).toHaveText(
        /Output limit reached: the cell printed more than 5,000,000 characters/
      );
      await expect(outputArea!).not.toContainText('hidden');
      expect((await uncaught).text()).toContain('Uncaught');
      await expect(outputArea!).not.toContainText('late');

      // The next cell prints again
      const next = await runCode(page, 'console.log("shown")');
      await expect(await getOutputs(page, next)).toHaveText(['shown\n']);
    });
  });
}

test.describe(`Output (${WORKER_KERNEL.displayName})`, () => {
  test('Show the output of a long loop while it runs', async ({ page }) => {
    await createNotebook(page, WORKER_KERNEL);

    const index = await runCode(
      page,
      [
        'const start = Date.now();',
        'let tick = 0;',
        'while (Date.now() - start < 3000) {',
        '  if (Date.now() - start >= tick * 100) console.log("tick " + tick++);',
        '}'
      ].join('\n'),
      { wait: false }
    );

    const stdout = await getOutputs(page, index, STDOUT);
    const prompt = (await page.notebook.getCellLocator(index))!.locator(
      '.jp-InputPrompt'
    );
    await expect(stdout).toContainText('tick 0', { timeout: 2000 });
    await expect(prompt).toHaveText('[*]:', { timeout: 100 });

    await page.notebook.waitForRun(index);
    await expect(stdout).toContainText('tick 29');
  });
});

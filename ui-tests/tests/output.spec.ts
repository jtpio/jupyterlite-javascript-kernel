// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  KERNELS,
  WORKER_KERNEL,
  createNotebook,
  getOutputs,
  openKernelSettings,
  runCode,
  setKernelSetting,
  waitForKernelIdle
} from './utils';

const STDOUT = 'application/vnd.jupyter.stdout';
const STDERR = 'application/vnd.jupyter.stderr';

/**
 * The code of a cell counting the ticks of the intervals for one second,
 * with the variables to count.
 */
function countTicks(...names: string[]): string {
  return [
    `const start = [${names.join(', ')}];`,
    'await new Promise(resolve => setTimeout(resolve, 1000));',
    `[${names.join(', ')}].map((count, i) => count - start[i]).join(' ')`
  ].join('\n');
}

/**
 * The numbers in the text output of a cell.
 */
async function getNumbers(
  page: IJupyterLabPageFixture,
  index: number
): Promise<number[]> {
  const [text] = await page.notebook.getCellTextOutput(index);
  return (text.match(/\d+/g) ?? []).map(Number);
}

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

for (const kernel of KERNELS) {
  test.describe(`Output limit (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('lab/index.html');
      const form = await openKernelSettings(page);
      await setKernelSetting(page, form, 'Output limit (characters)', '1000');
      await createNotebook(page, kernel, { open: false });
    });

    test('Limit each cell, not the cells printing at the same time', async ({
      page
    }) => {
      const interval = await runCode(
        page,
        "const timer = setInterval(() => console.log('x'.repeat(99)), 20);"
      );
      const intervalStdout = await getOutputs(page, interval, STDOUT);
      await expect(await getOutputs(page, interval, STDERR)).toContainText(
        'Output limit reached'
      );

      // Another cell prints while the interval runs, also after an await,
      // and shows its errors
      const index = await runCode(
        page,
        [
          "console.log('start');",
          'await new Promise(resolve => setTimeout(resolve, 300));',
          "console.log('end');",
          "setTimeout(() => { throw new Error('late'); });"
        ].join('\n')
      );
      await expect(await getOutputs(page, index, STDOUT)).toHaveText(
        'start\nend\n'
      );
      await expect(await getOutputs(page, index, STDERR)).toContainText(
        'Uncaught Error: late'
      );

      // Running a cell does not let the interval print more
      const printed = await intervalStdout.textContent();
      await runCode(page, '1 + 1');
      await page.waitForTimeout(300);
      expect(await intervalStdout.textContent()).toBe(printed);
      await runCode(page, 'clearInterval(timer);');
    });

    test('Print the outputs of a button after another cell reached its limit', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button } = Jupyter.widgets;',
          "const save = new Button({ description: 'Save' });",
          "save.onClick(() => console.log('saved'));",
          "const fail = new Button({ description: 'Fail' });",
          "fail.onClick(() => { throw new Error('not saved'); });",
          'display(save);',
          'display(fail);'
        ].join('\n')
      );
      const full = await runCode(page, "console.log('x'.repeat(2000));");
      await expect(await getOutputs(page, full, STDERR)).toContainText(
        'Output limit reached'
      );

      const outputs = await getOutputs(page, index);
      await outputs.getByRole('button', { name: 'Save' }).click();
      await expect(await getOutputs(page, index, STDOUT)).toHaveText('saved\n');
      await outputs.getByRole('button', { name: 'Fail' }).click();
      await expect(await getOutputs(page, index, STDERR)).toContainText(
        'Uncaught Error: not saved'
      );
    });

    test('Limit the outputs added to an Output widget after an await', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          "const print = new Button({ description: 'Print' });",
          'let clicks = 0;',
          'print.onClick(out.capture(async () => {',
          'const click = ++clicks;',
          'await new Promise(resolve => setTimeout(resolve, 100));',
          'console.log(`click ${click}`);',
          "for (let i = 0; i < 100; i++) console.log('x'.repeat(99));",
          "console.log('hidden');",
          '}, { clearOutput: true }));',
          'display(print);',
          'out'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const button = outputs.getByRole('button', { name: 'Print' });
      await button.click();

      const widget = outputs.locator('.widget-output');
      await expect(widget).toContainText(
        'Output limit reached: the cell printed more than 1,000 characters'
      );
      await expect(widget).toContainText('click 1');
      await expect(widget).not.toContainText('hidden');

      // Each click has its own limit
      await button.click();
      await expect(widget).toContainText('click 2');
      await expect(widget).toContainText('Output limit reached');
      await expect(widget).not.toContainText('click 1');
      await expect(widget).not.toContainText('hidden');
    });
  });
}

for (const kernel of KERNELS) {
  test.describe(`Timers of a cell run again (${kernel.displayName})`, () => {
    test('Stop the timers of a cell when it runs again', async ({ page }) => {
      const name = await createNotebook(page, kernel);
      const counter = await runCode(page, 'let ticks = 0;');
      const interval = await runCode(page, 'setInterval(() => ticks++, 100);');
      // Run the cell twice more, with Shift+Enter
      await page.notebook.runCell(interval);
      await page.notebook.runCell(interval);
      await page.waitForTimeout(1000);

      // One interval of 10 ticks per second, not three
      const count = await runCode(page, countTicks('ticks'));
      let [ticks] = await getNumbers(page, count);
      expect(ticks).toBeGreaterThanOrEqual(7);
      expect(ticks).toBeLessThanOrEqual(13);

      // Turn the setting off, and restart the kernel
      const form = await openKernelSettings(page);
      await setKernelSetting(
        page,
        form,
        'Stop the timers of a cell when it runs again',
        false
      );
      await page.activity.activateTab(name);
      await page.menu.clickMenuItem('Kernel>Restart Kernel…');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Confirm Kernel Restart' })
        .click();
      await waitForKernelIdle(page, kernel);

      // The three intervals keep running
      await page.notebook.runCell(counter);
      await page.notebook.runCell(interval);
      await page.notebook.runCell(interval);
      await page.notebook.runCell(interval);
      await page.waitForTimeout(1000);
      await page.notebook.runCell(count);
      [ticks] = await getNumbers(page, count);
      expect(ticks).toBeGreaterThanOrEqual(21);
      expect(ticks).toBeLessThanOrEqual(39);
    });

    test('Keep the timers of the other cells', async ({ page }) => {
      await createNotebook(page, kernel);
      await runCode(page, 'let a = 0;\nlet b = 0;');
      await runCode(page, 'setInterval(() => a++, 100);');
      // The timeouts created by the callbacks of the cell belong to it
      const chain = await runCode(
        page,
        '(function tick() {\nb++;\nsetTimeout(tick, 100);\n})();'
      );
      await page.notebook.runCell(chain);
      await page.notebook.runCell(chain);

      const count = await runCode(page, countTicks('a', 'b'));
      const [a, b] = await getNumbers(page, count);
      expect(a).toBeGreaterThanOrEqual(7);
      expect(a).toBeLessThanOrEqual(13);
      expect(b).toBeGreaterThanOrEqual(7);
      expect(b).toBeLessThanOrEqual(13);
    });

    test('Keep the timers with Jupyter.keepTimers', async ({ page }) => {
      await createNotebook(page, kernel);
      await runCode(page, 'Jupyter.keepTimers = true;\nlet ticks = 0;');
      const interval = await runCode(page, 'setInterval(() => ticks++, 100);');
      await page.notebook.runCell(interval);

      const count = await runCode(page, countTicks('ticks'));
      const [ticks] = await getNumbers(page, count);
      expect(ticks).toBeGreaterThanOrEqual(14);
      expect(ticks).toBeLessThanOrEqual(26);
    });
  });
}

test.describe(`Output (${WORKER_KERNEL.displayName})`, () => {
  test.beforeEach(async ({ page }) => {
    await createNotebook(page, WORKER_KERNEL);
  });

  test('Show the output printed before a long step while it runs', async ({
    page
  }) => {
    const index = await runCode(
      page,
      [
        "console.log('computing');",
        'const end = Date.now() + 3000;',
        'while (Date.now() < end) {}',
        "console.log('done');"
      ].join('\n'),
      { wait: false }
    );

    const stdout = await getOutputs(page, index, STDOUT);
    const prompt = (await page.notebook.getCellLocator(index))!.locator(
      '.jp-InputPrompt'
    );
    await expect(stdout).toHaveText('computing\n', { timeout: 2000 });
    await expect(prompt).toHaveText('[*]:', { timeout: 100 });

    await page.notebook.waitForRun(index);
    await expect(stdout).toHaveText('computing\ndone\n');
  });

  test('Show the output printed before a loop stopped by a restart', async ({
    page
  }) => {
    const index = await runCode(
      page,
      "console.log('starting');\nwhile (true) {}",
      { wait: false }
    );
    const cell = (await page.notebook.getCellLocator(index))!;
    await expect(cell.locator('.jp-InputPrompt')).toHaveText('[*]:');

    await page.menu.clickMenuItem('Kernel>Interrupt Kernel');
    await expect(await getOutputs(page, index, STDERR)).toContainText(
      'the Web Worker was restarted'
    );
    await expect(await getOutputs(page, index, STDOUT)).toHaveText(
      'starting\n'
    );
  });

  test('Show the output of a long loop while it runs', async ({ page }) => {
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

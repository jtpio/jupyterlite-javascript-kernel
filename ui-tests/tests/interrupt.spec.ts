// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  IFRAME_KERNEL,
  KERNELS,
  WORKER_KERNEL,
  createNotebook,
  getOutputs,
  runCode
} from './utils';

const STDERR = 'application/vnd.jupyter.stderr';

/**
 * The text of the error shown in the outputs of a cell.
 */
async function getErrorText(
  page: IJupyterLabPageFixture,
  index: number
): Promise<string> {
  const outputs = await getOutputs(page, index, STDERR);
  await expect(outputs).toHaveCount(1);
  return (await outputs.textContent()) ?? '';
}

/**
 * Wait until a cell shows an error containing some text.
 */
async function waitForError(
  page: IJupyterLabPageFixture,
  index: number,
  text: string | RegExp,
  timeout?: number
): Promise<void> {
  await expect(await getOutputs(page, index, STDERR)).toContainText(text, {
    timeout
  });
}

/**
 * Interrupt the kernel from the Kernel menu.
 */
async function interruptFromMenu(page: IJupyterLabPageFixture): Promise<void> {
  await page.menu.clickMenuItem('Kernel>Interrupt Kernel');
}

/**
 * Wait until a cell is running.
 */
async function waitForRunning(
  page: IJupyterLabPageFixture,
  index: number
): Promise<void> {
  const cell = await page.notebook.getCellLocator(index);
  await expect(cell!.locator('.jp-InputPrompt')).toHaveText('[*]:');
}

test.describe(`Loop timeout (${IFRAME_KERNEL.displayName})`, () => {
  test.beforeEach(async ({ page }) => {
    await createNotebook(page, IFRAME_KERNEL);
    await runCode(page, 'Jupyter.loopTimeout = 1000;');
  });

  test('Stop a loop freezing the page, and keep the state', async ({
    page
  }) => {
    // The editor indents the lines of the blocks
    const index = await runCode(
      page,
      ['let i = 0;', 'while (true) {', 'i++;', '}'].join('\n')
    );
    const text = await getErrorText(page, index);
    expect(text).toContain(
      'LoopTimeoutError: The while loop at line 2 of In[2] ran for more than 1 s'
    );
    expect(text).toContain('Jupyter.loopTimeout');
    expect(text).toContain('In[2]:2');
    expect(text).not.toContain('__jsKernelLoop__');

    let cell = await runCode(page, 'i > 0');
    expect(await page.notebook.getCellTextOutput(cell)).toEqual(['true']);
    cell = await runCode(page, '1 + 1');
    expect(await page.notebook.getCellTextOutput(cell)).toEqual(['2']);
  });

  test('Stop the loops of the functions of earlier cells', async ({ page }) => {
    await runCode(page, ['function spin() {', 'for (;;) {}', '}'].join('\n'));
    const index = await runCode(page, 'spin()');
    const text = await getErrorText(page, index);
    expect(text).toContain('The for loop at line 2 of In[2]');
    expect(text).toMatch(/at spin \(In\[2\]:2:\d+\)/);
    expect(text).toContain('at In[3]:1:1');
  });

  test('Stop a slow loop running after a fast loop', async ({ page }) => {
    // The fast loop checks the clock rarely, the slow loop at once
    const index = await runCode(
      page,
      [
        'for (let i = 0; i < 1e6; i++) {}',
        'let values = new Array(1e6).fill(0);',
        'while (true) {',
        'values = values.map(x => x + 1);',
        '}'
      ].join('\n')
    );
    expect(await getErrorText(page, index)).toContain(
      'The while loop at line 3 of In[2] ran for more than 1 s'
    );
  });

  test('Report the timeout caught by the code of the cell', async ({
    page
  }) => {
    const index = await runCode(
      page,
      "try { while (true) {} } catch (e) {}\n'after'"
    );
    expect(await getErrorText(page, index)).toContain('LoopTimeoutError');
    await expect(await getOutputs(page, index, 'text/plain')).toHaveCount(0);
  });

  test('Keep the line numbers of the cells with loops', async ({ page }) => {
    const index = await runCode(
      page,
      [
        'for (let i = 0; i < 3; i++) {}',
        'while (false) x;',
        'undefinedName'
      ].join('\n')
    );
    const text = await getErrorText(page, index);
    expect(text).toContain('In[2]:3');
    expect(text).toContain('ReferenceError: undefinedName is not defined');
    expect(text).toContain('at In[2]:3:1');
  });

  test('Change the loop timeout', async ({ page }) => {
    let index = await runCode(page, 'Jupyter.loopTimeout');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(['1000']);
    await runCode(page, 'Jupyter.loopTimeout = 0;');
    // Without limit, a loop of 1.5 s is not stopped
    index = await runCode(
      page,
      'const end = Date.now() + 1500;\nwhile (Date.now() < end) {}\n"done"'
    );
    expect(await page.notebook.getCellTextOutput(index)).toEqual(["'done'"]);
  });
});

for (const kernel of KERNELS) {
  test.describe(`Interrupt (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Run the loops as usual', async ({ page }) => {
      const index = await runCode(
        page,
        'let s = 0; for (let i = 0; i < 1e7; i++) s += i; s'
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        '49999995000000'
      ]);
    });

    test('Show the source of the functions with loops', async ({ page }) => {
      const index = await runCode(
        page,
        ['function count(n) {', 'while (n > 0) n--;', '}', 'count'].join('\n')
      );
      const html = await getOutputs(page, index, 'text/html');
      await expect(html).toContainText('while (n > 0) n--;');
      await expect(html).not.toContainText('__jsKernelLoop__');
    });

    test('Interrupt a cell waiting for a promise from the Kernel menu', async ({
      page
    }) => {
      await runCode(page, 'x = 42');
      const index = await runCode(page, 'await new Promise(() => {})', {
        wait: false
      });
      await waitForRunning(page, index);

      await interruptFromMenu(page);
      await waitForError(page, index, 'KeyboardInterrupt');
      expect(await getErrorText(page, index)).toContain(
        'KeyboardInterrupt: Execution interrupted'
      );

      const cell = await runCode(page, 'x');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['42']);
    });

    test('Run the loops of the widget callbacks after an interrupt', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const sum = new Jupyter.widgets.Button({ description: "Sum" });',
          'sum.onClick(() => {',
          'let total = 0;',
          'for (const value of [1, 2, 3]) total += value;',
          'console.log(`total ${total}`);',
          '});',
          'sum'
        ].join('\n')
      );
      const waiting = await runCode(page, 'await new Promise(() => {})', {
        wait: false
      });
      await waitForRunning(page, waiting);
      await interruptFromMenu(page);
      await waitForError(page, waiting, 'KeyboardInterrupt');

      await (await getOutputs(page, index))
        .getByRole('button', { name: 'Sum' })
        .click();
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('total 6\n');
      await expect(await getOutputs(page, index, STDERR)).toHaveCount(0);
    });

    test('Stop waiting for the change of a widget on interrupt', async ({
      page
    }) => {
      const index = await runCode(
        page,
        'const a = new Jupyter.widgets.IntSlider({ description: "a" });\na'
      );
      // The kernel handles the change of the slider after the cell: the cell
      // waits until it is interrupted
      const waiting = await runCode(
        page,
        'const v = await a.changed();\nconsole.log("got", v);',
        { wait: false }
      );
      await waitForRunning(page, waiting);
      await interruptFromMenu(page);
      await waitForError(page, waiting, 'KeyboardInterrupt');

      // The wait stopped: the next change does not resume the cell
      const widget = await getOutputs(page, index);
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(widget.locator('.widget-readout')).toHaveText('1');
      const cell = await runCode(page, 'a.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['1']);
      await expect(
        await getOutputs(page, waiting, 'application/vnd.jupyter.stdout')
      ).toHaveCount(0);
    });

    test('Enable the button of interact.manual again on interrupt', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { interact } = Jupyter.widgets;',
          'interact.manual(async ({ n }) => {',
          'console.log("waiting", n);',
          'await new Promise(resolve => setTimeout(resolve, 60000));',
          '}, { n: [0, 10] }, { manual_name: "Wait" })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const button = widget.getByRole('button', { name: 'Wait' });
      const output = widget.locator('.widget-output');
      await button.click();
      await expect(output).toHaveText('waiting 5\n');
      await expect(button).toBeDisabled();

      // The interrupt clears the timer of the run, which never ends
      await interruptFromMenu(page);
      await expect(button).toBeEnabled();
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(widget.locator('.widget-readout')).toHaveText('6');
      await button.click();
      await expect(output).toHaveText('waiting 6\n');
      await expect(button).toBeDisabled();
    });

    test('Interrupt an async loop from the toolbar', async ({ page }) => {
      const index = await runCode(
        page,
        'n = 0; while (true) { n++; await new Promise(r => setTimeout(r, 10)); }',
        { wait: false }
      );
      await waitForRunning(page, index);
      await page.waitForTimeout(300);

      await page.notebook.clickToolbarItem('interrupt');
      await waitForError(page, index, 'KeyboardInterrupt');

      const first = await runCode(page, 'n');
      await page.waitForTimeout(500);
      const second = await runCode(page, 'n');
      const [value] = await page.notebook.getCellTextOutput(first);
      expect(Number(value)).toBeGreaterThan(0);
      expect(await page.notebook.getCellTextOutput(second)).toEqual([value]);
    });

    test('Stop the intervals when the kernel is idle', async ({ page }) => {
      const index = await runCode(
        page,
        "setInterval(() => console.log('tick'), 100);"
      );
      const output = await getOutputs(page, index);
      await expect(output.first()).toContainText('tick');

      await interruptFromMenu(page);
      await page.waitForTimeout(300);
      const count = async () =>
        ((await output.allTextContents()).join('').match(/tick/g) ?? []).length;
      const before = await count();
      await page.waitForTimeout(600);
      expect(await count()).toBe(before);
    });

    test('Cancel the queued cells', async ({ page }) => {
      const first = await runCode(page, 'await new Promise(() => {})', {
        wait: false
      });
      await waitForRunning(page, first);
      const second = await runCode(page, "console.log('second')", {
        wait: false
      });

      await interruptFromMenu(page);
      await waitForError(page, first, 'KeyboardInterrupt');
      await waitForError(page, second, 'Kernel Interrupt');
      await expect(await getOutputs(page, second)).not.toContainText([
        'second'
      ]);
    });
  });
}

test.describe(`Restart after an interrupt (${WORKER_KERNEL.displayName})`, () => {
  test.beforeEach(async ({ page }) => {
    await createNotebook(page, WORKER_KERNEL);
  });

  test('Restart the Web Worker when a loop does not stop', async ({ page }) => {
    await runCode(page, 'y = 1');
    const index = await runCode(page, 'while (true) {}', { wait: false });
    await waitForRunning(page, index);

    // Interrupt with I, I in command mode
    const cell = await page.notebook.getCellLocator(index);
    await cell!.locator('.jp-InputPrompt').click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('i');
    await page.keyboard.press('i');
    await waitForError(page, index, 'KeyboardInterrupt');
    const text = await getErrorText(page, index);
    expect(text).toContain('the Web Worker was restarted');
    expect(text).toContain('are lost');

    let next = await runCode(page, 'typeof y');
    expect(await page.notebook.getCellTextOutput(next)).toEqual([
      "'undefined'"
    ]);
    next = await runCode(page, '1 + 1');
    expect(await page.notebook.getCellTextOutput(next)).toEqual(['2']);
  });

  test('Restart the Web Worker stuck in a timer', async ({ page }) => {
    await runCode(page, 'z = 1');
    const index = await runCode(page, 'setTimeout(() => { while (true) {} });');
    await page.waitForTimeout(300);

    await interruptFromMenu(page);
    await expect(await getOutputs(page, index)).toContainText(
      'The Web Worker did not stop after the interrupt, so it was restarted',
      { timeout: 10000 }
    );
    const cell = await runCode(page, 'typeof z');
    expect(await page.notebook.getCellTextOutput(cell)).toEqual([
      "'undefined'"
    ]);
  });

  test('Show new widgets after a restart', async ({ page }) => {
    let index = await runCode(
      page,
      'new Jupyter.widgets.IntSlider({ value: 3, description: "Before" })'
    );
    await expect(
      (await getOutputs(page, index)).getByText('Before')
    ).toBeVisible();

    index = await runCode(page, 'while (true) {}', { wait: false });
    await waitForRunning(page, index);
    await interruptFromMenu(page);
    await waitForError(page, index, 'KeyboardInterrupt');

    index = await runCode(
      page,
      'new Jupyter.widgets.IntSlider({ value: 7, description: "After" })'
    );
    const widget = await getOutputs(page, index);
    await expect(widget.getByText('After')).toBeVisible();
    await expect(widget.locator('.widget-readout')).toHaveText('7');
  });
});

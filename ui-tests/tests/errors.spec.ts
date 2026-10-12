// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  IFRAME_KERNEL,
  KERNELS,
  WORKER_KERNEL,
  createNotebook,
  getOutputs,
  runCode,
  waitForKernelIdle
} from './utils';

const STDERR = 'application/vnd.jupyter.stderr';

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

for (const kernel of KERNELS) {
  test.describe(`Errors (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Show the cell location of runtime errors', async ({ page }) => {
      await runCode(page, '1');
      // The editor indents the lines of the functions
      const index = await runCode(
        page,
        [
          'function inner() {',
          'throw new Error("boom")',
          '}',
          'function outer() {',
          'inner()',
          '}',
          'outer()'
        ].join('\n')
      );

      const lines = await getErrorLines(page, index);
      const source = lines[1];
      expect(lines[0]).toBe('In[2]:2');
      expect(source.trim()).toBe('throw new Error("boom")');
      expect(lines[2].indexOf('^')).toBe(source.indexOf('new'));
      expect(lines).toContain('Error: boom');
      expect(lines).toContain(
        `    at inner (In[2]:2:${source.indexOf('new') + 1})`
      );
      expect(lines).toContainEqual(
        expect.stringMatching(/^ {4}at outer \(In\[2\]:5:\d+\)$/)
      );
      expect(lines).toContain('    at In[2]:7:1');

      // No frames of the kernel
      const text = lines.join('\n');
      for (const internal of ['http', '.js:', '<anonymous>', 'eval at']) {
        expect(text).not.toContain(internal);
      }
    });

    test('Keep the line numbers after imports, declarations and the last expression', async ({
      page
    }) => {
      let index = await runCode(
        page,
        [
          'import {',
          'a',
          '} from "data:text/javascript,export const a = 1";',
          'let b;',
          'class C {}',
          'const d = a + 1',
          'd.missing.property'
        ].join('\n')
      );

      let lines = await getErrorLines(page, index);
      expect(lines.slice(0, 2)).toEqual(['In[1]:7', 'd.missing.property']);
      expect(lines[2].trim()).toBe('^');
      expect(lines).toContainEqual(expect.stringMatching(/^TypeError: /));

      // The value of the last expression is returned in place
      index = await runCode(page, 'function f() { return x.y }\nf()');

      lines = await getErrorLines(page, index);
      expect(lines).toContain('ReferenceError: x is not defined');
      expect(lines).toContainEqual(
        expect.stringMatching(/^ {4}at f \(In\[2\]:1:\d+\)$/)
      );
      expect(lines).toContain('    at In[2]:2:1');
    });

    test('Show syntax errors with the line and a caret', async ({ page }) => {
      const index = await runCode(page, 'let a = 1\nlet b = = 2');

      const lines = await getErrorLines(page, index);
      expect(lines).toEqual([
        'In[1]:2',
        'let b = = 2',
        '        ^',
        '',
        'SyntaxError: Unexpected token'
      ]);
    });

    test('Show values thrown that are not errors', async ({ page }) => {
      let index = await runCode(page, 'throw "x"');
      expect(await getErrorLines(page, index)).toEqual(["Uncaught 'x'"]);

      index = await runCode(page, 'throw { code: 1 }');
      expect(await getErrorLines(page, index)).toEqual([
        'Uncaught { code: 1 }'
      ]);
    });

    test('Show the cause and the aggregated errors', async ({ page }) => {
      let index = await runCode(
        page,
        'throw new Error("outer", { cause: new TypeError("inner") })'
      );

      let lines = await getErrorLines(page, index);
      expect(lines).toContain('Error: outer');
      expect(lines).toContain('  [cause]: TypeError: inner');
      expect(lines).toContain('      at In[1]:1:35');

      index = await runCode(
        page,
        'throw new AggregateError([new Error("a"), new RangeError("b")], "many")'
      );

      lines = await getErrorLines(page, index);
      expect(lines).toContain('AggregateError: many');
      expect(lines).toContain('  [errors]: [');
      expect(lines).toContain('    Error: a');
      expect(lines).toContain('    RangeError: b');
      expect(lines).toContain('  ]');
    });

    test('Show errors thrown later in callbacks', async ({ page }) => {
      let index = await runCode(
        page,
        'setTimeout(() => { throw new Error("later") }, 0)'
      );

      const lines = await getErrorLines(page, index);
      expect(lines[0]).toBe('In[1]:1');
      expect(lines).toContain('Uncaught Error: later');
      expect(lines).toContainEqual(
        expect.stringMatching(/^ {4}at In\[1\]:1:\d+$/)
      );

      // The kernel keeps running
      index = await runCode(page, '1 + 1');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);
    });

    test('Show unhandled promise rejections', async ({ page }) => {
      let index = await runCode(page, 'Promise.reject(new Error("nope"));');
      expect(await getErrorLines(page, index)).toContain(
        'Uncaught (in promise) Error: nope'
      );

      // An async function called without await
      index = await runCode(
        page,
        [
          'async function load() {',
          'throw new TypeError("not loaded")',
          '}',
          'load();'
        ].join('\n')
      );

      const lines = await getErrorLines(page, index);
      expect(lines[0]).toBe('In[2]:2');
      expect(lines).toContain('Uncaught (in promise) TypeError: not loaded');
      expect(lines).toContainEqual(
        expect.stringMatching(/^ {4}at load \(In\[2\]:2:\d+\)$/)
      );

      index = await runCode(page, '1 + 1');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);
    });

    test('Map the frames of logged and displayed errors', async ({ page }) => {
      let index = await runCode(
        page,
        [
          'function g() { return new Error("shown") }',
          'try { throw g() } catch (e) { console.error(e) }'
        ].join('\n')
      );

      const stderr = await getOutputs(page, index, STDERR);
      await expect(stderr).toContainText('Error: shown');
      await expect(stderr).toContainText('at g (In[1]:1:23)');
      await expect(stderr).toContainText('at In[1]:2:13');
      await expect(stderr).not.toContainText('http');

      // An error shown as the value of a cell
      index = await runCode(page, 'g()');

      const outputs = await getOutputs(page, index);
      await expect(outputs).toContainText('at g (In[1]:1:23)');
      await expect(outputs).toContainText('at In[2]:1:1');
      await expect(outputs).not.toContainText('http');

      // The frames of console.trace()
      index = await runCode(
        page,
        ['function t() { console.trace("here") }', 't()'].join('\n')
      );

      const trace = await getOutputs(page, index, STDERR);
      await expect(trace).toContainText('Trace: here');
      await expect(trace).toContainText('at t (In[3]:1:24)');
      await expect(trace).toContainText('at In[3]:2:1');
      await expect(trace).not.toContainText('http');
    });
  });
}

for (const kernel of KERNELS) {
  test.describe(`Error hints (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Suggest the names close to a misspelled name', async ({ page }) => {
      let index = await runCode(page, 'consle.log(1)');
      let lines = await getErrorLines(page, index);
      // The error is kept, the hint comes last
      expect(lines).toContain('ReferenceError: consle is not defined');
      expect(lines[lines.length - 1]).toBe('Did you mean: console?');

      index = await runCode(page, 'Math.flor(2.5)');
      lines = await getErrorLines(page, index);
      expect(lines).toContain('TypeError: Math.flor is not a function');
      expect(lines).toContain('Did you mean: Math.floor?');

      // A member read on undefined, which the message does not name
      index = await runCode(
        page,
        'const size = { width: 1 };\nsize.widht.toFixed()'
      );
      lines = await getErrorLines(page, index);
      expect(lines).toContain('Did you mean: size.width?');

      // A variable which is undefined gets no suggestion, even with a name
      // close to a global, like Node
      index = await runCode(
        page,
        'function area(node) {\nreturn node.width * 2;\n}\narea()'
      );
      lines = await getErrorLines(page, index);
      expect(lines.join('\n')).not.toContain('Did you mean');

      // The names declared by the cells are suggested too
      index = await runCode(page, 'const message = "hi";\nmesage');
      lines = await getErrorLines(page, index);
      expect(lines).toContain('Did you mean: message?');

      // No suggestion for a name far from the others
      index = await runCode(page, 'qwertyuiop');
      lines = await getErrorLines(page, index);
      expect(lines.join('\n')).not.toContain('Did you mean');
    });

    test('Explain the requests of fetch() which got no response', async ({
      page
    }) => {
      // Nothing listens on this port: no network is needed
      const index = await runCode(page, "await fetch('http://127.0.0.1:1/')");
      const lines = await getErrorLines(page, index);
      expect(lines).toContain('TypeError: Failed to fetch');
      const text = lines.join('\n');
      expect(text).toContain('check the URL and the network connection');
      expect(text).toContain('CORS');
    });
  });
}

test.describe(`Error hints (${WORKER_KERNEL.displayName})`, () => {
  test('Suggest the IFrame kernel for the DOM', async ({ page }) => {
    await createNotebook(page, WORKER_KERNEL);
    const index = await runCode(
      page,
      'document.title = "hints";\ndocument.title'
    );
    const lines = await getErrorLines(page, index);
    expect(lines).toContain('ReferenceError: document is not defined');
    expect(lines[lines.length - 1]).toBe(
      'document is not available in the JavaScript (Web Worker) kernel, which has no DOM: use Kernel > Change Kernel… > JavaScript (IFrame), or an OffscreenCanvas to draw.'
    );

    // Follow the hint, and run the cell again
    await page.menu.clickMenuItem('Kernel>Change Kernel…');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').selectOption(IFRAME_KERNEL.displayName);
    await dialog.getByRole('button', { name: 'Select' }).click();
    await waitForKernelIdle(page, IFRAME_KERNEL);

    await page.notebook.runCell(index);
    expect(await page.notebook.getCellTextOutput(index)).toEqual(["'hints'"]);
  });
});

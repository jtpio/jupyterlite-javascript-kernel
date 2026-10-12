// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';

import {
  IFRAME_KERNEL,
  KERNELS,
  createNotebook,
  getOutputs,
  runCode,
  waitForKernelIdle
} from './utils';

/**
 * Restart the kernel from the Kernel menu, and check that the variable
 * `name`, defined before, is gone and that the kernel runs code.
 */
async function restartKernel(
  page: IJupyterLabPageFixture,
  name: string
): Promise<void> {
  await page.menu.clickMenuItem('Kernel>Restart Kernel…');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm Kernel Restart' })
    .click();
  await waitForKernelIdle(page, IFRAME_KERNEL);
  let index = await runCode(page, `typeof ${name}`);
  expect(await page.notebook.getCellTextOutput(index)).toEqual(["'undefined'"]);
  index = await runCode(page, '1 + 1');
  expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);
}

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

    test('Keep declarations named like the accessors of the global scope', async ({
      page
    }) => {
      // `name` is a global of both the window and the Web Worker, which
      // only holds strings
      await runCode(page, 'const name = { a: 1 }');
      let index = await runCode(page, 'name.a');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['1']);

      // The functions named like an event handler install the handler
      await runCode(
        page,
        'function onmessageerror(event) {\nglobalThis.received = event.data;\n}'
      );
      index = await runCode(
        page,
        "dispatchEvent(new MessageEvent('messageerror', { data: 'hi' }));\nreceived"
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(["'hi'"]);
    });

    test('Run cells like a REPL', async ({ page }) => {
      // The export keywords are removed, keeping the declarations
      await runCode(
        page,
        'export const x = 1;\nexport function double(n) { return 2 * n; }'
      );
      let index = await runCode(page, 'double(x)');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);

      // A default export after a statement without a semicolon is not an
      // argument of the statement
      index = await runCode(
        page,
        "console.log('module')\nexport default { a: 1 }"
      );
      await expect(await getOutputs(page, index)).toHaveText(['module\n']);

      // The names reserved in modules can be declared, also next to an
      // import statement
      index = await runCode(page, 'const package = 3;\npackage');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['3']);
      index = await runCode(
        page,
        "import answer from 'data:text/javascript,export default 4';\nconst interface = answer;\ninterface"
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['4']);

      // A var declaration without a value keeps the value of the variable,
      // and the variable exists before its declaration
      await runCode(page, 'var z = 3;');
      index = await runCode(page, 'var z;\nz');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['3']);
      index = await runCode(page, 'console.log(y);\nvar y = 1;');
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['undefined\n']);
    });

    test('Keep the last result in _ and the last error in _error', async ({
      page
    }) => {
      await runCode(page, '21 * 2');
      let index = await runCode(page, '_ + 1');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['43']);

      // The cells without a value keep it
      await runCode(page, 'const unused = 1;');
      await runCode(page, '_ * 2;');
      index = await runCode(page, '_');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['43']);

      index = await runCode(page, 'null.x');
      await expect(await getOutputs(page, index)).toContainText('TypeError');
      index = await runCode(page, '_error.name');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'TypeError'"
      ]);

      // The errors thrown later, like in a timer
      index = await runCode(
        page,
        'setTimeout(() => { throw new RangeError("later") }, 0);'
      );
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stderr')
      ).toContainText('Uncaught RangeError: later');
      index = await runCode(page, '_error.message');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(["'later'"]);
    });

    test('Replace _ with an import or an assignment', async ({ page }) => {
      // Like lodash, imported as _
      await runCode(
        page,
        'import _ from \'data:text/javascript,export default "lodash"\';'
      );
      await runCode(page, '1 + 1');
      let index = await runCode(page, '_');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'lodash'"
      ]);

      await runCode(page, 'null.x');
      await runCode(page, '_error = "handled";');
      await runCode(page, 'undefined.y');
      index = await runCode(page, '_error');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'handled'"
      ]);
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
      const index = await runCode(page, 'const = 1');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        'In[1]:1\nconst = 1\n      ^\n\nSyntaxError: Unexpected token'
      ]);
    });

    test('Show object literals', async ({ page }) => {
      // A cell which is an object literal is not a block, with or without
      // parentheses
      for (const code of [
        '({ language: "JavaScript", year: 1995 })',
        '{ language: "JavaScript", year: 1995 }'
      ]) {
        const index = await runCode(page, code);

        const json = (await getOutputs(page, index)).and(
          page.locator('.jp-RenderedJSON')
        );
        await expect(json).toContainText('language');
        await expect(json).toContainText('"JavaScript"');
        await expect(json).toContainText('1995');
      }
    });
  });
}

test.describe(`IFrame runtime (${IFRAME_KERNEL.displayName})`, () => {
  test.beforeEach(async ({ page }) => {
    await createNotebook(page, IFRAME_KERNEL);
  });

  test('Keep running after a cell writes the document', async ({ page }) => {
    await runCode(page, 'let kept = "yes";');
    // document.write() after the load opens the document again
    await runCode(page, "document.write('<p>hi</p>')");
    let index = await runCode(page, '1 + 1');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);

    // The document is the one written, and the state of the cells is kept
    index = await runCode(page, 'document.close();\ndocument.body.textContent');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(["'hi'"]);
    index = await runCode(page, 'console.log(kept);\n1 + 2');
    await expect(await getOutputs(page, index)).toHaveText(['yes\n', '3']);

    await restartKernel(page, 'kept');
  });

  test('Lay out the DOM and run the animation frames', async ({ page }) => {
    const index = await runCode(
      page,
      [
        "const box = document.createElement('div');",
        "box.style.width = '120px';",
        "box.textContent = 'Laid out';",
        'document.body.appendChild(box);',
        'const frame = await Promise.race([',
        '  new Promise(resolve => requestAnimationFrame(time => resolve(typeof time))),',
        "  new Promise(resolve => setTimeout(() => resolve('no frame'), 2000))",
        ']);',
        'const visible = await new Promise(resolve => {',
        '  new IntersectionObserver(([entry]) => resolve(entry.isIntersecting)).observe(box);',
        '});',
        'const { width, height } = box.getBoundingClientRect();',
        "[box.offsetWidth, width, height > 0, innerWidth, innerHeight, frame, visible].join(', ')"
      ].join('\n')
    );
    expect(await page.notebook.getCellTextOutput(index)).toEqual([
      "'120, 120, true, 800, 600, number, true'"
    ]);

    // The iframe is not shown, and the cells can not take the keyboard away
    // from the notebook
    await expect(
      page.locator('iframe[srcdoc*="<title>JavaScript Kernel</title>"]')
    ).toBeHidden();
    const focused = await runCode(
      page,
      [
        "const field = document.createElement('input');",
        'document.body.appendChild(field);',
        'field.focus();',
        'await new Promise(resolve => setTimeout(resolve, 100));'
      ].join('\n')
    );
    // Shift+Enter moved to a new cell, where the typed text goes
    await page.keyboard.type('typed');
    expect(await page.notebook.getCellTextInput(focused + 1)).toEqual('typed');
    await page.keyboard.press('Escape');
    await page.keyboard.press('b');
    await expect(page.locator('.jp-Notebook .jp-Cell')).toHaveCount(
      focused + 3
    );
  });

  test('Restart the iframe reloaded by a cell', async ({ page }) => {
    await runCode(page, 'let before = 1;');
    let index = await runCode(page, 'location.reload()');
    await expect(
      await getOutputs(page, index, 'application/vnd.jupyter.stderr')
    ).toHaveText(
      'The code reloaded or left the page of the iframe, so the runtime was restarted: the variables, functions and imports of the previous cells are lost.\n'
    );

    index = await runCode(page, 'typeof before');
    expect(await page.notebook.getCellTextOutput(index)).toEqual([
      "'undefined'"
    ]);
    index = await runCode(page, 'typeof document');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(["'object'"]);

    await runCode(page, 'let after = 2;');
    await restartKernel(page, 'after');
  });

  test('Fail the cell running when the iframe is reloaded', async ({
    page
  }) => {
    let index = await runCode(
      page,
      'setTimeout(() => location.reload(), 200);\nawait new Promise(() => {});'
    );
    await expect(
      await getOutputs(page, index, 'application/vnd.jupyter.stderr')
    ).toHaveText(
      'RuntimeReloadedError: The code reloaded or left the page of the iframe, so the runtime was restarted: the variables, functions and imports of the previous cells are lost. Run those cells again.'
    );

    index = await runCode(page, '1 + 1');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);
  });

  test('Refuse to redeclare the globals which can not be replaced', async ({
    page
  }) => {
    // Assigning `location` would navigate the iframe away
    let index = await runCode(page, "const location = 'Paris';");
    expect(await page.notebook.getCellTextOutput(index)).toEqual([
      "In[1]:1\nconst location = 'Paris';\n      ^\n\nSyntaxError: 'location' is a built-in global and cannot be redeclared in a cell; pick another name"
    ]);

    // A var declaration without a value keeps the global, as in a script
    index = await runCode(page, 'var window;\nwindow === globalThis');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(['true']);

    // The kernel keeps running, in the same page
    index = await runCode(page, 'typeof location');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(["'object'"]);
    index = await runCode(page, '1 + 1');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);
  });

  test('Ignore the messages posted to the window of the iframe', async ({
    page
  }) => {
    // A request to execute some code, as other windows could post it
    let index = await runCode(
      page,
      [
        'postMessage({',
        "id: 'request',",
        "type: 'APPLY',",
        "path: ['execute'],",
        'argumentList: [',
        "{ type: 'RAW', value: 'globalThis.posted = true' },",
        "{ type: 'RAW', value: 0 }",
        ']',
        "}, '*');",
        'await new Promise(resolve => setTimeout(resolve, 500));',
        "'posted'"
      ].join('\n')
    );
    // The message was posted without an error
    expect(await page.notebook.getCellTextOutput(index)).toEqual(["'posted'"]);
    index = await runCode(page, 'typeof posted');
    expect(await page.notebook.getCellTextOutput(index)).toEqual([
      "'undefined'"
    ]);
  });
});

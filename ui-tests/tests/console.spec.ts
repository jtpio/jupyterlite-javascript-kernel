// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import {
  IFRAME_KERNEL,
  KERNELS,
  createNotebook,
  getOutputs,
  runCode
} from './utils';

const STDOUT = 'application/vnd.jupyter.stdout';
const STDERR = 'application/vnd.jupyter.stderr';

for (const kernel of KERNELS) {
  test.describe(`Console (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Print values like Node.js', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log({ a: { b: { c: { d: 1 } } } }, [1, 2], new Map([["key", true]]))'
      );

      await expect(await getOutputs(page, index, STDOUT)).toHaveText([
        "{ a: { b: { c: [Object] } } } [ 1, 2 ] Map(1) { 'key' => true }\n"
      ]);
    });

    test('Print the state of platform objects', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log(new Blob(["hi"]), new URLSearchParams("a=1&b=2"))'
      );

      await expect(await getOutputs(page, index, STDOUT)).toHaveText([
        "Blob { size: 2, type: '' } URLSearchParams { 'a' => '1', 'b' => '2', size: 2 }\n"
      ]);
    });

    test('Print iterators without their constructor', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log(new Map([["a", 1]]).keys(), [1, 2].values())'
      );

      await expect(await getOutputs(page, index, STDOUT)).toHaveText([
        'Object [Map Iterator] {} Object [Array Iterator] {}\n'
      ]);
    });

    test('Replace the format specifiers', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log("%s has %d items: %o", "The list", 3, ["a", "b", "c"])'
      );

      await expect(await getOutputs(page, index, STDOUT)).toHaveText([
        "The list has 3 items: [ 'a', 'b', 'c' ]\n"
      ]);
    });

    test('Show tables', async ({ page }) => {
      const index = await runCode(
        page,
        'console.table([{ name: "Ada", year: 1815 }, { name: "Grace", year: 1906 }])'
      );

      const table = (await getOutputs(page, index, 'text/html')).getByRole(
        'table'
      );
      await expect(table.getByRole('columnheader')).toHaveText([
        '(index)',
        'name',
        'year'
      ]);
      await expect(table.getByRole('row').nth(2)).toHaveText('1Grace1906');
    });

    test('Group, count, time and assert', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'console.group("Group");',
          'console.log("inside");',
          'console.groupEnd();',
          'console.count();',
          'console.count();',
          'console.time("timer");',
          'console.timeEnd("timer");',
          'console.assert(1 + 1 === 3, "math is broken");'
        ].join('\n')
      );

      const stdout = await getOutputs(page, index, STDOUT);
      await expect(stdout).toContainText(
        'Group\n  inside\ndefault: 1\ndefault: 2\ntimer: '
      );
      await expect(stdout).toContainText(/timer: \d+\.\d{3}ms/);
      await expect(await getOutputs(page, index, STDERR)).toHaveText([
        'Assertion failed: math is broken\n'
      ]);
    });

    test('Clear the outputs', async ({ page }) => {
      const index = await runCode(
        page,
        'console.log("before");\nconsole.clear();\nconsole.log("after");'
      );

      await expect(await getOutputs(page, index)).toHaveText(['after\n']);
    });
  });
}

test.describe(`Console (${IFRAME_KERNEL.displayName})`, () => {
  test.beforeEach(async ({ page }) => {
    await createNotebook(page, IFRAME_KERNEL);
  });

  test('Print DOM nodes as short tags', async ({ page }) => {
    const index = await runCode(
      page,
      [
        'const list = document.createElement("ul");',
        'list.id = "items";',
        'list.innerHTML = \'<li class="first">One</li><li>Two</li>\';',
        'console.log(document.createElement("div"));',
        'console.log(list);',
        'console.log(list.childNodes);',
        'console.log({ text: list.firstChild.firstChild });',
        'console.log(list.attributes, list.getAttributeNode("id"));'
      ].join('\n')
    );

    await expect(await getOutputs(page, index, STDOUT)).toHaveText([
      [
        '<div>',
        '<ul id="items">',
        'NodeList(2) [ <li class="first">, <li> ]',
        "{ text: #text 'One' }",
        'NamedNodeMap(1) [ id="items" ] id="items"',
        ''
      ].join('\n')
    ]);
  });
});

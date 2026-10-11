// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import { KERNELS, createNotebook, getOutputs, runCode } from './utils';

for (const kernel of KERNELS) {
  test.describe(`Widgets (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Sync a slider with the kernel', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { IntSlider } = Jupyter.widgets;',
          'const slider = new IntSlider({ value: 5, max: 10, description: "Level" });',
          'slider'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const readout = widget.locator('.widget-readout');
      await expect(widget.getByText('Level')).toBeVisible();
      await expect(readout).toHaveText('5');

      // From the frontend to the kernel
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(readout).toHaveText('7');
      const cell = await runCode(page, 'slider.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['7']);

      // From the kernel to the frontend
      await runCode(page, 'slider.value = 2;');
      await expect(readout).toHaveText('2');
    });

    test('Handle button clicks', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'let clicks = 0;',
          'const output = new Output();',
          'const button = new Button({ description: "Click me" });',
          'button.onClick(() => {',
          'clicks += 1;',
          'output.appendStdout(`Clicked ${clicks} times\\n`);',
          '});',
          'display(button);',
          'output'
        ].join('\n')
      );
      const widgets = await getOutputs(page, index);

      const button = widgets.getByRole('button', { name: 'Click me' });
      await button.click();
      await button.click();
      await expect(widgets.locator('.widget-output')).toContainText(
        'Clicked 2 times'
      );

      const cell = await runCode(page, 'clicks');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['2']);
    });

    test('Observe the changes made in the frontend', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Dropdown, Label, VBox } = Jupyter.widgets;',
          'const fruit = new Dropdown({ options: ["Apple", "Banana", "Cherry"], description: "Fruit" });',
          'const label = new Label({ value: "Nothing selected" });',
          'fruit.observe(change => { label.value = `Selected ${change.new}`; }, "value");',
          'new VBox({ children: [fruit, label] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      await expect(widget.getByText('Nothing selected')).toBeVisible();

      await widget.getByRole('combobox').selectOption('Banana');
      await expect(widget.getByText('Selected Banana')).toBeVisible();
    });

    test('Link widgets in the frontend', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { IntSlider, IntText, HBox, jslink } = Jupyter.widgets;',
          'const source = new IntSlider({ value: 1, description: "Source" });',
          'const target = new IntText({ value: 1, description: "Target" });',
          'jslink([source, "value"], [target, "value"]);',
          'new HBox({ children: [source, target] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);

      const input = widget.getByRole('spinbutton');
      await input.fill('9');
      await input.press('Enter');
      await expect(widget.locator('.widget-readout')).toHaveText('9');

      const cell = await runCode(page, '`${source.value} and ${target.value}`');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'9 and 9'"
      ]);
    });

    test('Show widgets in containers', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Tab, IntSlider, Text } = Jupyter.widgets;',
          'new Tab({',
          'children: [new IntSlider({ value: 3 }), new Text({ value: "second page" })],',
          'titles: ["Slider", "Text"]',
          '})'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);

      await expect(widget.locator('.widget-slider')).toBeVisible();
      await widget.getByRole('tab', { name: 'Text' }).click();
      await expect(widget.getByRole('textbox')).toHaveValue('second page');
      await expect(widget.locator('.widget-slider')).toBeHidden();
    });
  });
}

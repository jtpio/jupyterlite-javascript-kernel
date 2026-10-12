// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import {
  KERNELS,
  createNotebook,
  getOutputs,
  runCode,
  waitForKernelIdle
} from './utils';

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

    test('Show the errors of the button handlers', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Button, HBox } = Jupyter.widgets;',
          'const failing = new Button({ description: "Fail" });',
          'failing.onClick(() => {',
          'throw new Error("bad click");',
          '});',
          'const rejecting = new Button({ description: "Fail later" });',
          'rejecting.onClick(async () => {',
          'throw new Error("bad async click");',
          '});',
          'new HBox({ children: [failing, rejecting] })'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const stderr = await getOutputs(
        page,
        index,
        'application/vnd.jupyter.stderr'
      );

      // The errors are printed on stderr, one after the other
      await outputs.getByRole('button', { name: 'Fail', exact: true }).click();
      await expect(stderr).toContainText('Uncaught Error: bad click');
      await expect(stderr).toContainText('at In[1]:4:');

      await outputs.getByRole('button', { name: 'Fail later' }).click();
      await expect(stderr).toContainText(
        'Uncaught (in promise) Error: bad async click'
      );

      // The button still works
      await outputs.getByRole('button', { name: 'Fail', exact: true }).click();
      await expect(stderr).toHaveText(
        /bad click[^]*bad async click[^]*bad click/
      );
    });

    test('Show the errors of the callbacks captured by an Output', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Output } = Jupyter.widgets;',
          'const output = new Output();',
          'const job = output.capture(async () => {',
          'throw new Error("captured");',
          '});',
          'job();'
        ].join('\n')
      );

      const outputArea = await page.notebook.getCellOutputLocator(index);
      await expect(outputArea!).toContainText(
        'Uncaught (in promise) Error: captured'
      );
    });

    test('Capture the console in an Output widget', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Output } = Jupyter.widgets;',
          'const out = new Output();',
          'display(out);',
          'console.log("outside");',
          'out.capture(() => console.log("inside"))();',
          'console.log("after");'
        ].join('\n')
      );

      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');
      await expect(widget).toContainText('inside');
      await expect(widget).not.toContainText('outside');
      await expect(widget).not.toContainText('after');
      // The output of the widget, then the ones of the cell
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['inside\n', 'outside\nafter\n']);
    });

    test('Capture the outputs of a button callback in an Output widget', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          'const log = new Button({ description: "Log" });',
          'log.onClick(out.capture(() => console.log("clicked")));',
          'const load = new Button({ description: "Load" });',
          'load.onClick(out.capture(async () => {',
          'console.log("loading");',
          'await null;',
          'console.log("ready");',
          'await new Promise(resolve => setTimeout(resolve, 200));',
          'console.log("loaded");',
          '}));',
          'display(log);',
          'display(load);',
          'out'
        ].join('\n')
      );
      // Another cell runs after
      const later = await runCode(page, 'console.log("later")');
      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');

      await outputs.getByRole('button', { name: 'Log' }).click();
      await expect(widget).toContainText('clicked');

      // The outputs after an await too
      await outputs.getByRole('button', { name: 'Load' }).click();
      await expect(widget).toContainText('loaded');
      await expect(widget).toHaveText(
        /^clicked\s+loading\s+ready\s+loaded\s*$/
      );

      // Only in the widget: the stream outputs of the cell are the ones of
      // the widget
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['clicked\nloading\nready\nloaded\n']);
      await expect(await getOutputs(page, later)).toHaveText(['later\n']);
    });

    test('Print the outputs of the widget callbacks in their cell', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, IntSlider } = Jupyter.widgets;',
          'const slider = new IntSlider({ value: 5, description: "Level" });',
          'slider.observe(change => console.log(`level ${change.new}`), "value");',
          'const button = new Button({ description: "Hello" });',
          'button.onClick(() => console.log("hello"));',
          'display(button);',
          'slider'
        ].join('\n')
      );
      const later = await runCode(page, 'console.log("later")');
      const outputs = await getOutputs(page, index);

      await outputs.getByRole('button', { name: 'Hello' }).click();
      await outputs.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['hello\nlevel 6\n']);
      await expect(await getOutputs(page, later)).toHaveText(['later\n']);

      // Called by the code of a cell, the callback prints in that cell
      const set = await runCode(page, 'slider.value = 8;');
      await expect(await getOutputs(page, set)).toHaveText(['level 8\n']);
    });

    test('Clear and append to an Output widget', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          'out.appendStdout("text\\n");',
          'out.appendDisplayData(6 * 7);',
          'out.appendDisplayData(new Button({ description: "Inside" }));',
          'out.appendDisplayData({ "text/html": "<b>bold</b>" });',
          'out'
        ].join('\n')
      );
      const widget = (await getOutputs(page, index)).locator('.widget-output');
      await expect(widget).toContainText('text');
      await expect(widget).toContainText('42');
      await expect(
        widget.getByRole('button', { name: 'Inside' })
      ).toBeVisible();
      await expect(widget.locator('b')).toHaveText('bold');

      // Cleared when the next output arrives
      await runCode(page, 'out.clearOutput({ wait: true });');
      await expect(widget).toContainText('42');
      await runCode(page, 'out.appendStdout("replaced\\n");');
      await expect(widget).toHaveText(/^replaced\s*$/);

      // A button showing only the outputs of its last click
      const counter = await runCode(
        page,
        [
          'let count = 0;',
          'const counter = new Button({ description: "Count" });',
          'counter.onClick(out.capture({ clearOutput: true, wait: true })(() => {',
          'console.log(`count ${++count}`);',
          '}));',
          'counter'
        ].join('\n')
      );
      const button = (await getOutputs(page, counter)).getByRole('button', {
        name: 'Count'
      });
      await button.click();
      await expect(widget).toHaveText(/^count 1\s*$/);
      await button.click();
      await expect(widget).toHaveText(/^count 2\s*$/);
      await runCode(page, 'out.clearOutput();');
      await expect(widget).toHaveText('');

      // Cleared when a captured output arrives
      const note = await runCode(
        page,
        [
          'const note = new Button({ description: "Note" });',
          'note.onClick(out.capture(() => console.log("note")));',
          'out.appendStdout("old\\n");',
          'out.clearOutput({ wait: true });',
          'note'
        ].join('\n')
      );
      await expect(widget).toHaveText(/^old\s*$/);
      await (await getOutputs(page, note))
        .getByRole('button', { name: 'Note' })
        .click();
      await expect(widget).toHaveText(/^note\s*$/);
      await runCode(page, 'out.appendStdout("more\\n");');
      await expect(widget).toHaveText(/^note\s+more\s*$/);
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

    test('Show images from their bytes', async ({ page }) => {
      // A red PNG image of 3x2 pixels
      const index = await runCode(
        page,
        [
          'const { Image } = Jupyter.widgets;',
          'const png = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==";',
          'const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));',
          'const image = new Image({ value: bytes, format: "png", width: "60" });',
          'image'
        ].join('\n')
      );
      const img = (await getOutputs(page, index)).getByRole('img');
      const naturalWidth = () =>
        img.evaluate(element => (element as HTMLImageElement).naturalWidth);

      await expect(img).toHaveAttribute('width', '60');
      await expect.poll(naturalWidth).toBe(3);

      // New bytes are sent to the frontend
      await runCode(
        page,
        [
          'const svg = \'<svg xmlns="http://www.w3.org/2000/svg" width="5" height="4"><rect width="5" height="4" fill="blue"/></svg>\';',
          'image.format = "svg+xml";',
          'image.value = new TextEncoder().encode(svg);'
        ].join('\n')
      );
      await expect.poll(naturalWidth).toBe(5);
    });

    test('Select the options by value, with labelled options', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Dropdown } = Jupyter.widgets;',
          'const d = new Dropdown({ options: [["One", 1], ["Two", 2]], value: 2, description: "Number" });',
          'd.observe(change => console.log(`value ${change.new}`), "value");',
          'd'
        ].join('\n')
      );
      const combobox = (await getOutputs(page, index)).getByRole('combobox');
      await expect(combobox).toHaveValue('Two');
      let cell = await runCode(page, 'd.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['2']);

      // The value of the option chosen in the frontend
      await combobox.selectOption('One');
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('value 1\n');
      cell = await runCode(page, 'd.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['1']);

      // The selected value is kept when the options change
      cell = await runCode(
        page,
        'd.options = { Zero: 0, Uno: 1, Three: 3 };\n`${d.label} ${d.value}`'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'Uno 1'"]);
      await expect(combobox).toHaveValue('Uno');
      cell = await runCode(page, 'd.value = 5;');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('RangeError: Invalid selection: value not found');

      // An option given as undefined is left out
      cell = await runCode(
        page,
        'new Dropdown({ options: ["A", "B"], index: undefined }).value'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'A'"]);

      // A range of two options, the lower one first
      cell = await runCode(
        page,
        [
          'const { SelectionRangeSlider } = Jupyter.widgets;',
          'const range = new SelectionRangeSlider({ options: ["A", "B", "C"], value: ["A", "C"] });',
          'range.options = ["C", "B", "A"];',
          '`${range.index}`'
        ].join('\n')
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'0,2'"]);
      cell = await runCode(page, 'range.value = ["B"];');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText(
        'RangeError: Invalid selection: index must have two values'
      );

      // Values which are not JSON, like a cyclic object or a bigint
      const radio = await runCode(
        page,
        [
          'const { RadioButtons } = Jupyter.widgets;',
          'const cyclic = { name: "cyclic" };',
          'cyclic.self = cyclic;',
          'const r = new RadioButtons({ options: { Cyclic: cyclic, Big: 10n } });',
          'r.observe(change => console.log(`picked ${change.new === cyclic ? "cyclic" : change.new}`), "value");',
          'r'
        ].join('\n')
      );
      const radios = await getOutputs(page, radio);
      await radios.getByRole('radio', { name: 'Big' }).check();
      await radios.getByRole('radio', { name: 'Cyclic' }).check();
      await expect(
        await getOutputs(page, radio, 'application/vnd.jupyter.stdout')
      ).toHaveText('picked 10\npicked cyclic\n');
    });

    test('Style and lay out the widgets with plain objects', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button } = Jupyter.widgets;',
          'const b = new Button({ description: "Go", style: { button_color: "rgb(255, 0, 0)" } });',
          'b.layout.width = "200px";',
          'b'
        ].join('\n')
      );
      const button = (await getOutputs(page, index)).getByRole('button', {
        name: 'Go'
      });
      await expect(button).toHaveCSS('width', '200px');
      await expect(button).toHaveCSS('background-color', 'rgb(255, 0, 0)');

      await runCode(
        page,
        [
          'b.tooltip = "hint";',
          'b.style.button_color = "rgb(0, 128, 0)";',
          'b.layout = { width: "120px", border: "3px solid rgb(0, 0, 255)" };',
          'b.addClass("my-button");'
        ].join('\n')
      );
      await expect(button).toHaveAttribute('title', 'hint');
      await expect(button).toHaveCSS('background-color', 'rgb(0, 128, 0)');
      await expect(button).toHaveCSS('width', '120px');
      await expect(button).toHaveCSS('border-left-width', '3px');
      await expect(button).toHaveClass(/my-button/);

      // A description as wide as its text
      const slider = await runCode(
        page,
        [
          'const { IntSlider } = Jupyter.widgets;',
          'const s = new IntSlider({ description: "A long description" });',
          's.style.description_width = "initial";',
          's'
        ].join('\n')
      );
      const label = (await getOutputs(page, slider)).getByText(
        'A long description'
      );
      await expect(label).toBeVisible();
      await expect
        .poll(() =>
          label.evaluate(element => element.scrollWidth <= element.clientWidth)
        )
        .toBe(true);
      const cell = await runCode(
        page,
        '`${s.layout instanceof Jupyter.widgets.Layout} ${s.style instanceof Jupyter.widgets.SliderStyle}`'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'true true'"
      ]);
    });

    test('Keep the numeric values in their bounds', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { HBox, IntSlider } = Jupyter.widgets;',
          'const s = new IntSlider({ value: 150, description: "Clamped" });',
          'const t = new IntSlider({ value: 150, max: 200, description: "Fits" });',
          'new HBox({ children: [s, t] })'
        ].join('\n')
      );
      const readouts = (await getOutputs(page, index)).locator(
        '.widget-readout'
      );
      await expect(readouts).toHaveText(['100', '150']);
      let cell = await runCode(page, 's.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['100']);

      // Lowering the max lowers the value
      cell = await runCode(page, 's.max = 10;\ns.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['10']);
      await expect(readouts).toHaveText(['10', '150']);

      // Integers are rounded, and the bounds checked
      cell = await runCode(page, 's.value = 3.7;\ns.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['4']);
      await expect(readouts).toHaveText(['4', '150']);
      cell = await runCode(page, 's.min = 20;');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('RangeError: setting min > max');
      cell = await runCode(
        page,
        'new Jupyter.widgets.IntRangeSlider({ value: [8, 3] })'
      );
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('RangeError: setting lower > upper');

      // A bound given as undefined keeps its default
      cell = await runCode(
        page,
        'new IntSlider({ value: 5, max: undefined }).max'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['100']);
    });

    test('Pass the button to its click handlers, and the custom messages to onMsg', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button } = Jupyter.widgets;',
          'const button = new Button({ description: "Click me" });',
          'button.onClick(b => { b.description = "Clicked"; });',
          'button.onMsg(content => console.log(`message ${content.event}`));',
          'button'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      await outputs.getByRole('button', { name: 'Click me' }).click();
      await expect(
        outputs.getByRole('button', { name: 'Clicked' })
      ).toBeVisible();
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('message click\n');
    });

    test('Show the widgets again when the notebook is reopened', async ({
      page
    }) => {
      // A red PNG image of 3x2 pixels, sent to the frontend as a buffer
      const index = await runCode(
        page,
        [
          'const { HBox, Image, IntSlider } = Jupyter.widgets;',
          'const png = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==";',
          'const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));',
          'const slider = new IntSlider({ value: 5, max: 10, description: "Level" });',
          'const image = new Image({ value: bytes, format: "png", width: "60" });',
          'new HBox({ children: [slider, image] })'
        ].join('\n')
      );
      let widget = await getOutputs(page, index);
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(widget.locator('.widget-readout')).toHaveText('6');

      // Save, close the tab, and open the notebook again: the kernel keeps
      // running, with its widgets
      const notebook = 'Widgets.ipynb';
      await page.menu.clickMenuItem('File>Save Notebook');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill(notebook);
      await dialog.getByRole('button', { name: 'Rename and Save' }).click();
      const tab = page.activity.getTabLocator(notebook);
      await expect(tab).not.toHaveClass(/jp-mod-dirty/);
      await page.menu.clickMenuItem('File>Close Tab');
      await expect(tab).toHaveCount(0);
      await page.filebrowser.open(notebook);
      await waitForKernelIdle(page, kernel);

      widget = await getOutputs(page, index);
      const readout = widget.locator('.widget-readout');
      await expect(widget.getByText('Level')).toBeVisible();
      await expect(readout).toHaveText('6');
      const img = widget.getByRole('img');
      await expect(img).toHaveAttribute('width', '60');
      await expect
        .poll(() =>
          img.evaluate(element => (element as HTMLImageElement).naturalWidth)
        )
        .toBe(3);

      // The slider still drives the value in the kernel, and the other way
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(readout).toHaveText('7');
      const cell = await runCode(page, 'slider.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['7']);
      await runCode(page, 'slider.value = 2;');
      await expect(readout).toHaveText('2');
    });
  });
}

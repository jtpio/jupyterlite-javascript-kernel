# jupyterlite-javascript-kernel

[![Github Actions Status](https://github.com/jupyterlite/javascript-kernel/workflows/Build/badge.svg)](https://github.com/jupyterlite/javascript-kernel/actions/workflows/build.yml)
[![lite-badge](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)](https://jupyterlite.github.io/javascript-kernel/lab/index.html)

A JavaScript kernel for JupyterLite.

![a screenshot showing a notebook with the JavaScript kernel in JupyterLite](https://github.com/jupyterlite/javascript-kernel/assets/591645/c9085a6e-452e-4f77-8553-36133ee32389)

## Requirements

- JupyterLite >=0.3.0

This kernel was originally maintained as part of the main JupyterLite repository, and was moved to its own repository for the JupyterLite 0.3.0 release.

## Install

To install the extension, execute:

```bash
pip install jupyterlite-javascript-kernel
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlite-javascript-kernel
```

## Runtime modes

The extension currently registers two JavaScript kernelspecs:

- `JavaScript (IFrame)`:
  Runs code in a hidden runtime `iframe` on the main page thread. Use this when your code needs browser DOM APIs like `document`, `window`, or canvas access through the page context.
- `JavaScript (Web Worker)`:
  Runs code in a dedicated Web Worker. Use this for stronger isolation and to avoid blocking the main UI thread.

Pick either kernel from the notebook kernel selector in JupyterLite.

### Kernel information

The kernel banner shows the version of the kernel and the runtime it uses, for
example `JavaScript kernel 0.4.0 for JupyterLite (Web Worker runtime)`. It is
shown at the top of consoles, and in the dialog opened from **Help > About the
JavaScript (IFrame) Kernel** or **Help > About the JavaScript (Web Worker)
Kernel**.

The language version in the kernel info, saved in the `language_info` of the
notebook metadata, is the ECMAScript edition that the kernel parses, like
`ES2026`. The browser decides which built-in APIs exist.

While a JavaScript notebook or console is active, the **Help** menu also links
to the MDN JavaScript Reference, the MDN Web APIs and this README.

### Kernel startup extensions

Frontend extensions can register startup work that runs before user code in
both runtime modes. Use this to preload runtime modules and register comm
targets without sending bootstrap code through `requestExecute`.

```typescript
import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { IJavaScriptKernelStartupRegistry } from '@jupyterlite/javascript-kernel';

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'my-extension:javascript-startup',
  autoStart: true,
  requires: [IJavaScriptKernelStartupRegistry],
  activate: (app, startup) => {
    const runtimeBootstrap = new URL(
      './runtime-bootstrap.js',
      import.meta.url
    ).toString();
    const lspCommTarget = new URL(
      './lsp-comm-target.js',
      import.meta.url
    ).toString();

    startup.registerStartupExtension({
      id: 'my-extension:lsp',
      activate: async context => {
        await context.preloadModule(runtimeBootstrap);
        await context.registerCommTarget({
          targetName: 'my-extension:lsp',
          module: lspCommTarget,
          exportName: 'registerLspTarget'
        });
      },
      deactivate: async context => {
        await context.unregisterCommTarget('my-extension:lsp');
      }
    });
  }
};
```

`context.registerCommTarget()` imports the module in the kernel runtime and
passes the exported handler to `Jupyter.comm.registerTarget(targetName,
handler)`. The default export is used when `exportName` is omitted. Disposing
a startup registration calls its optional `deactivate` callback for active
kernels.

A startup extension which throws does not stop the kernel: the next cell
prints `The startup extension "my-extension:lsp" failed, so the kernel runs
without it: Error: ...` on stderr, then runs as usual.

### Runtime startup failures

When the runtime can not start, for example when the script of the Web Worker
does not load (offline, or blocked by a content security policy), or when the
iframe does not load within 10 s, the kernel still answers: the cells fail
with `RuntimeStartupError: JavaScript runtime failed to start: <reason>.
Restart the kernel to try again.` instead of staying at `[*]`, and the kernel
banner, in consoles and in the **Help** menu, shows the reason too.

### Worker mode limitations

Web Workers do not expose DOM APIs. In `JavaScript (Web Worker)`, APIs such as `document`, direct element access, and other main-thread-only browser APIs are unavailable.

When the code of a cell does not stop after an interrupt, the kernel restarts the Web Worker, and the variables, functions, imports and widgets of the previous cells are lost. See [Interrupting code and loop protection](#interrupting-code-and-loop-protection). After `close()`, which stops the Web Worker, the cells fail with `The JavaScript runtime stopped: ... Restart the kernel.` instead of running forever.

### Iframe mode

In `JavaScript (IFrame)`, `document.write()` and `document.open()` replace the content of the runtime iframe, and the kernel keeps running, with the variables of the previous cells. When the code reloads the iframe or navigates it away, like with `location.reload()` or `location.href = '...'`, the kernel starts a new iframe and prints `The code reloaded or left the page of the iframe, so the runtime was restarted: ...`: the variables, functions, imports and widgets of the previous cells are lost. A cell still running at that moment fails with a `RuntimeReloadedError`.

The kernel calls the runtime of the iframe directly, from the page: it does not handle the messages posted to the window of the iframe, so other windows, like a page embedding JupyterLite, can not run code in the kernel with `postMessage()`.

### Import side effects in iframe mode

In `JavaScript (IFrame)`, user code and imports execute in the runtime iframe scope.

By default, module-level side effects stay in the runtime iframe. To intentionally affect the main page (`window.parent`), access it directly.

Cell declarations like `var`, `let`, `const`, `function`, and `class` remain in the runtime scope. Host-page mutations happen when your code (or imported code) explicitly reaches `window.parent`.

#### Example: canvas-confetti

```javascript
import confetti from 'canvas-confetti';

const canvas = window.parent.document.createElement('canvas');
Object.assign(canvas.style, {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: '2147483647'
});
window.parent.document.body.appendChild(canvas);

const fire = confetti.create(canvas, { resize: true, useWorker: true });

fire({ particleCount: 20, spread: 70 });
```

#### Example: p5.js

```javascript
import p5 from 'p5';

const mount = window.parent.document.createElement('div');
Object.assign(mount.style, {
  position: 'fixed',
  right: '16px',
  bottom: '16px',
  zIndex: '1000'
});
window.parent.document.body.appendChild(mount);

const sketch = new p5(p => {
  p.setup = () => {
    p.createCanvas(120, 80);
    p.noLoop();
  };
}, mount);
```

#### Can side effects be auto-detected and cleaned up?

Partially, yes, but not perfectly. This project currently does not provide automatic side-effect cleanup for host-page mutations.

Limits of automatic cleanup:

- It will not reliably undo monkey-patched globals.
- It will not automatically remove all event listeners or timers.
- It cannot safely revert all stateful third-party module internals.

## Cells

The cells run like in a REPL, such as the Node.js REPL:

- The top-level declarations (`var`, `let`, `const`, `function`, `class` and the imported names) become globals, shared with the next cells. A cell can declare a name again, and the `const` and `let` declarations are not constant: `const a = 1` followed by `a = 2` works.
- A `var` declaration without a value keeps the value of the variable, and the variable exists before its declaration, like in a script: `var z;` does not reset `z`, and `console.log(y); var y = 1` prints `undefined`.
- A cell which is an object literal, like `{ a: 1, b: 2 }`, shows the object, instead of running a block.
- The `export` keywords are ignored, so the code of a module can be pasted in a cell: `export const x = 1` declares `x`, the `export { ... }` lists are removed, and `export ... from '...'` loads the module.
- The cells can use top-level `await` and the `import` statements of the modules, and they run in sloppy mode, so the names reserved only in strict mode, like `package` or `interface`, can be declared, also in a cell with `import` or `export` statements.
- The declarations named like a global of the browser keep their value: after `const name = { a: 1 }`, `name.a` is `1` in the next cells, instead of `window.name` turning the value to a string, and `function onmessage(event) {}` installs the event handler. The globals which can not be replaced, like `location`, `top`, `window` and `document` in `JavaScript (IFrame)`, can not be declared: `const location = 'Paris'` fails with `SyntaxError: 'location' is a built-in global and cannot be redeclared in a cell; pick another name`, instead of navigating the iframe away. As in a script, a `var` declaration without a value, like `var window;`, keeps the global.

## Imports

The `import` statements of the cells load the npm packages by name from the [jsDelivr](https://www.jsdelivr.com/) CDN, with the magic imports:

```javascript
import confetti from 'canvas-confetti';
import { capitalize } from 'lodash-es';
import * as d3 from 'd3-array@3';
```

The import sources are rewritten like this:

- a package name, with an optional version and path, loads from `https://cdn.jsdelivr.net/npm/`, with `/+esm` added for jsDelivr to serve an ES module: `lodash-es` loads `https://cdn.jsdelivr.net/npm/lodash-es/+esm`, and `d3-array@3` loads `https://cdn.jsdelivr.net/npm/d3-array@3/+esm`
- the paths ending with `.js`, `.mjs`, `.cjs`, `.wasm` or `+esm` get no `/+esm`: `lodash-es/capitalize.js` loads `https://cdn.jsdelivr.net/npm/lodash-es/capitalize.js`
- the sources starting with `npm/` or `gh/` keep their path: `gh/user/repo/file.js` loads `https://cdn.jsdelivr.net/gh/user/repo/file.js`
- a query or a hash stays at the end, after `/+esm`
- the URLs (`https://...`), the protocol-relative URLs (`//...`), the relative and absolute paths (`./`, `../`, `/`) and the import map specifiers (`#...`) are left unchanged

The packages load at run time, so the magic imports need a network connection to the CDN. The CDN, the rules and the magic imports themselves can be changed in the [settings](#settings), for example to use [esm.sh](https://esm.sh/) or packages hosted with the JupyterLite site. Only the `import` statements at the top level of the cells are rewritten: `await import()` loads a URL, like `await import('https://cdn.jsdelivr.net/npm/dayjs/+esm')`. The modules loaded by name by the [startup extensions](#kernel-startup-extensions) use the same rules.

## Interrupting code and loop protection

The stop button of the notebook toolbar, **Kernel > Interrupt Kernel** and <kbd>I</kbd>, <kbd>I</kbd> stop the running cell with `KeyboardInterrupt: Execution interrupted`, and cancel the cells waiting to run. The variables of the cell are kept. An interrupt also clears the `setTimeout()` and `setInterval()` timers created by the cells, so it stops the background intervals, even when no cell is running.

- A cell waiting for a promise that never settles, an `await` in a loop and a sleep loop stop at once, in both kernels.
- `JavaScript (IFrame)` runs on the thread of the page, so a synchronous loop freezes JupyterLite: the page can not even handle the stop button. A loop running for more than 10 s without letting the page respond is stopped with a `LoopTimeoutError`, like `The while loop at line 2 of In[3] ran for more than 10 s without letting the page respond, so it was stopped.`, and the kernel keeps its state. The time spent waiting in `alert()`, `confirm()` and `prompt()` does not count. Change the limit for the next kernels with the **Loop timeout (ms)** [setting](#settings), in a cell with `Jupyter.loopTimeout = 30000` (in ms, 0 turns it off), or with the `loopTimeout` option of the kernel, or run long computations in `JavaScript (Web Worker)`.
- `JavaScript (Web Worker)` runs off the page thread, so the page stays responsive. When the page is cross-origin isolated (served with the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` or `credentialless` headers), the loops stop at once and the state is kept. Otherwise, code that does not yield is stopped by restarting the Web Worker after 2 s, or at once with a second interrupt: the cell explains that the variables, functions, imports and widgets of the previous cells are lost.

`KeyboardInterrupt` and `LoopTimeoutError` can be caught, but the loops keep throwing them, `KeyboardInterrupt` until the next execution and `LoopTimeoutError` until the page handles a task, and the cell is reported as failed even when its code caught them.

Limitations:

- The loops in the code of imported modules, in `eval()` and `new Function()` strings, and the long calls to built-in functions are not stopped in `JavaScript (IFrame)`, and in `JavaScript (Web Worker)` they only stop when the Web Worker is restarted.
- `prompt()` in `JavaScript (IFrame)` is the native dialog of the browser, which blocks the page until it is closed.
- The sketch of the p5.js kernel shown with `%show` runs in its own iframe, without loop protection.
- An interrupted cell is abandoned, not unwound: its `finally` blocks do not run, and a pending `fetch()` may still resume it later. Its output then goes to the last cell that ran.
- The guard checked by the loops makes the loops doing almost nothing about twice as slow. The loops doing real work, and the array methods like `map()`, are barely affected.

## Rich output

The last expression of a cell is shown as its result. The values are printed like with `util.inspect` in Node.js, and the data with a JSON representation, like objects and arrays, is also shown as an interactive tree.

`display(value, options)` shows values in the middle of a cell. With the `id` option (`true` to generate one), it returns a handle to update the output later, also from other cells:

```javascript
const task = display.text('Starting...', { id: true });
await new Promise(resolve => setTimeout(resolve, 1000));
task.update('Done!');
```

The `metadata` option sets the metadata of the output. `handle.display(value)` shows a new output, updated together with the other outputs of the handle.

The helpers of `display` show content for the common MIME types:

- `display.html`, `display.markdown`, `display.svg`, `display.latex` and `display.text` take a string, or are used as tagged templates: ``display.markdown`**${name}**` ``
- `display.json(value)` shows an interactive JSON tree
- `display.png(bytes, { width, height })` and `display.jpeg(...)` show images, from their bytes or base64
- `display.mime(bundle)` shows a MIME bundle, like `{ 'text/html': '<b>Hi</b>', 'text/plain': 'Hi' }`

`clearOutput(wait)` clears the outputs of the cell. With `wait` set to `true`, they are cleared when the next output arrives, to avoid flickering.

Objects can define their own representation, with a `[Symbol.for('Jupyter.display')]()` or `_toMime()` method returning a MIME bundle, or with the `_toHtml()`, `_toMarkdown()`, `_toSvg()`, `_toPng()`, `_toJpeg()`, `_toLatex()` and `_toJson()` methods:

```javascript
class Temperature {
  constructor(celsius) {
    this.celsius = celsius;
  }

  [Symbol.for('Jupyter.display')]() {
    return {
      'text/html': `<b>${this.celsius} °C</b>`,
      'text/plain': `${this.celsius} °C`
    };
  }
}

new Temperature(21);
```

> **Note:** the second argument of `display()` used to be the metadata of the output. It is now an object of options, with the metadata under `metadata`.

## Console

The `console` methods print to the outputs of the cell, with the values formatted like in Node.js:

- `console.log`, `console.info` and `console.debug` print to the standard output, `console.error`, `console.warn` and `console.trace` to the standard error
- the format specifiers `%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O` and `%c` are replaced, like `console.log('%s is %d', 'answer', 42)`
- `console.table` shows a table, `console.dir` an object with options like `{ depth }`
- `console.group`, `console.groupCollapsed` and `console.groupEnd` indent the messages
- `console.count`, `console.countReset`, `console.time`, `console.timeLog`, `console.timeEnd` and `console.assert` work like in the browser
- `console.clear` clears the outputs of the cell
- consecutive writes to the standard output or the standard error are sent together, at most every 50 ms, so printing thousands of lines in a loop is fast. The outputs keep their order: the pending text is sent before any rich output, error, widget message or prompt, and when the cell finishes. In the Web Worker kernel, a long loop shows its output while it runs
- the code running after its cell prints in the outputs of the cell which started it, even after other cells ran: the callbacks of `setTimeout`, `setInterval` and `requestAnimationFrame` print in the cell which created them, so an interval or an animation keeps its outputs in its own cell, and the callbacks of the [widgets](#jupyter-widgets), like a click handler, print in the cell which registered them. The other code running later, like the code after an `await` in a callback, an event listener or the callback of a promise, prints in the cell that ran last. When a cell runs again, the notebook forgets the outputs of its previous run: the timers of that run which still print are not shown anymore, interrupt the kernel to stop them
- a cell prints at most 5,000,000 characters on the standard output and the standard error, about 50,000 lines of 100 characters: the rest is not shown, and a notice is printed instead. This stops a runaway loop of `console.log` before it freezes the page. Change the limit with the **Output limit (characters)** [setting](#settings). The count starts again with the next cell, or when the cell calls `console.clear()` or `clearOutput()`. The errors thrown later by a cell that reached the limit, in a timer or an event listener, are printed in the console of the browser

## Errors

An error shows where it happened in the cell, then its frames, like in Node.js:

```
In[3]:2
  throw new Error("boom")
        ^

Error: boom
    at inner (In[3]:2:9)
    at outer (In[3]:5:3)
    at In[3]:7:1
```

- `In[3]` is the execution count of the cell, followed by the line and the column. The frames of the functions defined in other cells show the cell where they are defined. The frames of the kernel are hidden.
- Syntax errors show the line and a caret under the column, before running the cell.
- Values thrown that are not errors are shown as is, like `Uncaught 'x'` for `throw "x"`.
- The `cause` of an error and the errors of an `AggregateError` are shown nested, under `[cause]:` and `[errors]:`.
- `console.error(error)`, `console.trace()` and the errors shown as values use the same locations.
- The errors thrown later, in a timer, an event listener or the handler of a widget, are printed on stderr as `Uncaught Error: ...`, with the other outputs of the code that threw them (see [Console](#console)): the errors of a timer in the cell which created it, the ones of a widget handler in the cell which registered it, the others in the last cell that ran. The promises rejected without a handler, like an async function called without `await`, are printed as `Uncaught (in promise) Error: ...`. The kernel keeps running. These errors are shown in the notebook instead of the console of the browser.

The columns can differ slightly between browsers, which point at different parts of the expression that failed.

## Input

`prompt(message)` asks the user for some text, and returns it:

```javascript
const name = prompt('What is your name?');
```

- In `JavaScript (Web Worker)`, the question is shown in the output area, like `input()` in Python kernels. `prompt.password(message)` hides the answer. The JupyterLite service worker relays the question to the page, so it needs a secure context (JupyterLite served over `https`, or on `localhost`) and a browser allowing service workers (not, for example, the private windows of Firefox). Without it, `prompt()` fails with a `StdinNotImplementedError` naming the fix, instead of returning `null`. It also fails when the frontend does not support input requests (an `execute_request` with `allow_stdin: false`), and in the code that runs after its cell, like a timer.
- In `JavaScript (IFrame)`, the code runs on the main thread of the page, so `prompt()` is the dialog of the browser. It works everywhere.

## Completion and documentation

Press **Tab** to complete the names defined in the kernel, and the properties of objects and literals like `"text".toUpp`. The completer shows the type of each completion, like `class` or `function`.

Press **Shift+Tab**, or open **Help > Show Contextual Help**, to see the documentation of the name under the cursor: its signature, its JSDoc comment, and its source. The built-in objects link to their page on MDN, and the names which are not defined show suggestions.

```javascript
/**
 * Compute the area of a circle.
 * @param {number} radius - The radius of the circle
 */
function circleArea(radius) {
  return Math.PI * radius ** 2;
}
```

## Jupyter Widgets

The kernel provides built-in support for [Jupyter Widgets](https://ipywidgets.readthedocs.io/) (`ipywidgets`-compatible). Widget classes and helpers are available under `Jupyter.widgets`; destructure the ones you need before using them:

```javascript
const { IntSlider, IntProgress, jslink } = Jupyter.widgets;

const slider = new IntSlider({
  value: 50,
  min: 0,
  max: 100,
  description: 'My Slider'
});
const progress = new IntProgress({
  value: 50,
  min: 0,
  max: 100,
  description: 'Mirror'
});
display(slider);
display(progress);

slider.observe(({ new: value }) => {
  console.log('Slider value:', value);
}, 'value');

jslink([slider, 'value'], [progress, 'value']);
```

Widgets auto-display when they are the last expression in a cell. Use the global `display()` function to display a widget explicitly, for example when assigning to a variable.

The outputs of the callbacks of the widgets, like `button.onClick()` and `slider.observe()`, go to the cell which registered the callback, even after other cells ran. When the code of a cell triggers the callback, like by setting `slider.value`, they go to that cell. To show them somewhere else, like under a button, capture them in an `Output` widget:

```javascript
const { Button, Output } = Jupyter.widgets;

const button = new Button({ description: 'Count stars' });
const out = new Output();
button.onClick(
  out.capture(
    async () => {
      console.log('Loading...');
      const response = await fetch(
        'https://api.github.com/repos/jupyterlite/javascript-kernel'
      );
      const { stargazers_count } = await response.json();
      console.log(`${stargazers_count} stars`);
    },
    { clearOutput: true, wait: true }
  )
);
display(button);
display(out);
```

- `out.capture(callback, options?)`, or `out.capture(options)(callback)`, returns a function which runs `callback` with its outputs (the `console`, `display()`, `clearOutput()`) shown in the widget. The outputs of an async callback after an `await` are captured too, until its promise settles: while it runs, the outputs of the other code running outside of the cells, after an `await`, also go to the widget. With the `clearOutput` option, the outputs of the widget are removed first, when the next output arrives with `wait`. The errors of the callback go to the cell which registered it.
- `out.appendStdout(text)` and `out.appendStderr(text)` add some text, and `out.appendDisplayData(value, metadata?)` adds a value shown like `display()` shows it, like a widget, or a MIME bundle like `{ 'text/html': '<b>Hi</b>' }`
- `out.clearOutput({ wait })` removes the outputs of the widget, with `wait` when the next output arrives

Widgets also work when JupyterLite is served over plain http, for example on a LAN, where the browser hides some APIs like `crypto.randomUUID` (only `prompt()` in `JavaScript (Web Worker)` needs the service worker, which needs `https` or `localhost`).

### Available widgets

- **Numeric**: `IntSlider`, `FloatSlider`, `FloatLogSlider`, `IntRangeSlider`, `FloatRangeSlider`, `Play`, `IntProgress`, `FloatProgress`, `IntText`, `FloatText`, `BoundedIntText`, `BoundedFloatText`
- **Boolean**: `Checkbox`, `ToggleButton`, `Valid`
- **Selection**: `Dropdown`, `RadioButtons`, `Select`, `SelectMultiple`, `ToggleButtons`, `SelectionSlider`, `SelectionRangeSlider`
- **String**: `Text`, `Textarea`, `Password`, `Combobox`
- **Display**: `Label`, `HTML`, `HTMLMath`, `Output`
- **Button**: `Button` (with `.onClick()` handler)
- **Color**: `ColorPicker`
- **Media**: `Image` (from bytes, sent as binary buffers)
- **Layout / Style**: `Layout`, `DescriptionStyle`, `SliderStyle`, `ProgressStyle`, `ButtonStyle`, `CheckboxStyle`, `ToggleButtonStyle`, `ToggleButtonsStyle`, `TextStyle`, `HTMLStyle`, `HTMLMathStyle`, `LabelStyle`
- **Containers**: `Box`, `HBox`, `VBox`, `GridBox`, `Accordion`, `Tab`, `Stack`
- **Helpers**: `jslink`, `jsdlink`

### Ported widget modules

The widget runtime is split into files that roughly follow the upstream `ipywidgets` package structure so it is easier to track what has been ported.

| Upstream `ipywidgets` file                           | Local file                                                                    | Status  | Notes                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| `packages/base/src/widget.ts`                        | `packages/javascript-kernel-runtime/src/widgets/widget.ts`                    | Ported  | Kernel-side `Widget` and `DOMWidget` equivalents                     |
| `packages/base/src/widget_layout.ts`                 | `packages/javascript-kernel-runtime/src/widgets/widget_layout.ts`             | Ported  | Layout models                                                        |
| `packages/base/src/widget_style.ts`                  | `packages/javascript-kernel-runtime/src/widgets/widget_style.ts`              | Ported  | Shared style models, plus control-specific styles gathered here      |
| `packages/controls/src/widget_int.ts`                | `packages/javascript-kernel-runtime/src/widgets/widget_int.ts`                | Ported  | Integer widgets, play, progress, and text inputs                     |
| `packages/controls/src/widget_float.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_float.ts`              | Ported  | Float widgets                                                        |
| `packages/controls/src/widget_bool.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_bool.ts`               | Ported  | Boolean widgets; related styles live in `widget_style.ts`            |
| `packages/controls/src/widget_selection.ts`          | `packages/javascript-kernel-runtime/src/widgets/widget_selection.ts`          | Partial | Selection semantics still differ from `ipywidgets` in some cases     |
| `packages/controls/src/widget_string.ts`             | `packages/javascript-kernel-runtime/src/widgets/widget_string.ts`             | Ported  | String and display widgets; related styles live in `widget_style.ts` |
| `packages/output/src/output.ts`                      | `packages/javascript-kernel-runtime/src/widgets/widget_output.ts`             | Ported  | Output capture, also of async callbacks, and the `append*` methods   |
| `packages/controls/src/widget_button.ts`             | `packages/javascript-kernel-runtime/src/widgets/widget_button.ts`             | Partial | Button widget is present, but callback behavior differs slightly     |
| `packages/controls/src/widget_color.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_color.ts`              | Ported  | Color picker                                                         |
| `packages/controls/src/widget_box.ts`                | `packages/javascript-kernel-runtime/src/widgets/widget_box.ts`                | Ported  | Box, HBox, VBox, GridBox                                             |
| `packages/controls/src/widget_selectioncontainer.ts` | `packages/javascript-kernel-runtime/src/widgets/widget_selectioncontainer.ts` | Ported  | Accordion, Tab, Stack                                                |
| `packages/controls/src/widget_link.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_link.ts`               | Ported  | `jslink`, `jsdlink`, `Link`, and `DirectionalLink`                   |
| `packages/controls/src/widget_image.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_image.ts`              | Ported  | `Image`; `Video` and `Audio` are not ported yet                      |

> **Note:** `jupyterlab-widgets`, `@jupyter-widgets/controls`, and `@jupyter-widgets/output` must be available in the JupyterLite deployment for the full widget set to render.

See the [example notebook](examples/widgets.ipynb) for more usage examples.

## Comms

`Jupyter.comm` opens [comms](https://jupyter-client.readthedocs.io/en/latest/messaging.html#custom-messages) with the frontend, the channel of the widgets, for frontend extensions talking to the code of the cells:

```javascript
// A comm opened by the kernel
const comm = Jupyter.comm.open('my-target', { hello: 'frontend' });
comm.onMsg = (data, buffers) => console.log('received', data);
comm.send({ value: 42 });

// The comms opened by the frontend on a target
Jupyter.comm.registerTarget('my-echo', (comm, data, buffers) => {
  comm.onMsg = data => comm.send(data);
  comm.onClose = data => console.log('closed');
});
```

- `Jupyter.comm.open(targetName, data?, metadata?, buffers?)` opens a comm and returns it
- `Jupyter.comm.registerTarget(targetName, handler)` calls `handler(comm, data, buffers)` when the frontend opens a comm on the target, and `Jupyter.comm.unregisterTarget(targetName)` removes it. A comm opened on a target without a handler, or whose handler throws, is closed, like in `ipykernel`
- a comm has a `commId` and a `targetName`, `send(data, metadata?, buffers?)` and `close(data?)` methods, and the `onMsg` and `onClose` callbacks, called with the data and the binary buffers (`ArrayBuffer`) of the messages of the frontend
- the outputs of the comm callbacks, and their errors, go to the cell which ran last. The comm messages they send, and the outputs captured by an `Output` widget, go to the message of the frontend which they handle

`context.registerCommTarget()` registers the target of a [startup extension](#kernel-startup-extensions) before the code of the cells runs.

## Configuration

### Settings

Open **Settings > Settings Editor** and search for **JavaScript Kernel** to change the settings of the kernels. They apply to the kernels started next: the running kernels keep their settings until **Kernel > Restart Kernel**.

| Setting                   | Key                     | Default                     | Effect                                                                                                                                                               |
| ------------------------- | ----------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Magic imports             | `magicImports`          | `true`                      | Load the packages imported by name from a CDN, see [Imports](#imports). When disabled, only URLs and the specifiers of an import map can be imported.                |
| CDN base URL              | `magicImportsBaseUrl`   | `https://cdn.jsdelivr.net/` | The base URL of the CDN. A relative URL, like `vendor/`, is resolved against the URL of the JupyterLite site.                                                        |
| Add the npm/ prefix       | `magicImportsNpmPrefix` | `true`                      | Load `lodash-es` from `<CDN base URL>/npm/lodash-es`, like jsDelivr. Disable it for the CDNs serving the packages at their root, like esm.sh.                        |
| Add the +esm suffix       | `magicImportsEsmSuffix` | `true`                      | Add `/+esm` after the package paths which do not end with `.js`, `.mjs`, `.cjs` or `.wasm`, for jsDelivr to serve ES modules. Disable it for other CDNs.             |
| Loop timeout (ms)         | `loopTimeout`           | `10000`                     | The time a loop can keep the page busy in `JavaScript (IFrame)` before it is stopped, see [loop protection](#interrupting-code-and-loop-protection). 0 turns it off. |
| Output limit (characters) | `maxStreamOutput`       | `5000000`                   | The number of characters a cell can print with the `console` methods, see [Console](#console). 0 for no limit.                                                       |

The settings are saved in the browser, for each user. A custom CDN in the settings of a user can make a shared notebook behave differently for them: the defaults of a deployment belong in `overrides.json`.

### Default settings for a deployment

A JupyterLite deployment sets the defaults of the settings with an `overrides.json` file in the lite directory (where `jupyter lite build` runs). The build merges it into the `jupyter-lite.json` of the site, and `jupyter lite check` validates it against the schema of the settings. The users can still change the settings.

Load the packages from [esm.sh](https://esm.sh/):

```json
{
  "@jupyterlite/javascript-kernel-extension:kernel-settings": {
    "magicImportsBaseUrl": "https://esm.sh/",
    "magicImportsNpmPrefix": false,
    "magicImportsEsmSuffix": false
  }
}
```

Serve the packages with the site, to work offline, from a `vendor` folder next to the `index.html` of the site with the layout of jsDelivr, like `vendor/npm/lodash-es/lodash.js` imported with `import _ from 'lodash-es/lodash.js'`:

```json
{
  "@jupyterlite/javascript-kernel-extension:kernel-settings": {
    "magicImportsBaseUrl": "vendor/"
  }
}
```

Turn off the magic imports:

```json
{
  "@jupyterlite/javascript-kernel-extension:kernel-settings": {
    "magicImports": false
  }
}
```

The CDN also serves the modules that the [startup extensions](#kernel-startup-extensions) load by name: a CDN without them breaks those extensions.

### Enable or disable specific modes

The two runtime modes are registered by separate plugins:

- `@jupyterlite/javascript-kernel-extension:kernel-iframe`
- `@jupyterlite/javascript-kernel-extension:kernel-worker`

You can disable either one using `disabledExtensions` in `jupyter-config-data`.

Disable worker mode:

```json
{
  "jupyter-config-data": {
    "disabledExtensions": [
      "@jupyterlite/javascript-kernel-extension:kernel-worker"
    ]
  }
}
```

Disable iframe mode:

```json
{
  "jupyter-config-data": {
    "disabledExtensions": [
      "@jupyterlite/javascript-kernel-extension:kernel-iframe"
    ]
  }
}
```

Disabling `@jupyterlite/javascript-kernel-extension:kernel-settings` makes the kernels ignore the settings, and use the built-in defaults.

## Contributing

### Packages

The repository contains three npm packages:

- `@jupyterlite/javascript-kernel-runtime`: the code running next to the user code, in the iframe or the Web Worker. It executes the cells, formats the outputs, and implements comms and widgets. It does not depend on JupyterLite, so that other JavaScript kernels can reuse it. It is engine-neutral: it only needs the ECMAScript built-ins, and compiles without the DOM types, which the build checks. It also ships single-file builds, with `acorn`, `acorn-walk` and `astring` included, for kernels that do not use npm, and exports the engine-neutral helpers of the tracebacks, like `parseStack` and `formatError`, for other kernels. The evaluator batches the stream outputs: a host can pass its `scheduler` (or `null` when the engine has no host timers, and then calls `evaluator.flushOutputs()` itself), a `flushInterval` (0 turns the batching off) and a `maxStreamOutput` per cell. It interrupts the cells with `evaluator.interrupt()`, and stops the loops with a `loopTimeout` or, from another thread, an `interruptBuffer`. Its output messages carry the `parentHeader` of the message of the frontend they belong to (the cell which created a timer or registered a widget callback, or the comm message whose outputs an `Output` widget captures), given to `execute()` and to the comm handlers, and `JavaScriptKernel` publishes them with it. The `executorOptions` of the evaluator (an `IExecutorOptions`, as plain data) configure the magic imports, also of an existing executor, like `ExecutorConfig.update()`. See its [README](packages/javascript-kernel-runtime/README.md).
- `@jupyterlite/javascript-kernel`: the JupyterLite kernel, with the iframe and Web Worker runtimes. It also exports everything from `@jupyterlite/javascript-kernel-runtime`. The iframe backend calls the runtime API directly in the page, and the Web Worker backend over Comlink. When the code of a cell reloads the iframe, `IFrameRuntimeBackend` calls its `onRestart` option and starts a new iframe, for which it calls `executorFactory` and `onReady` again: the `onRuntimeReady` method of the kernels building on `JavaScriptKernel`, like the p5.js kernel, runs again with the new global scope and executor. JupyterLite only cancels the queued cells on interrupt: `installKernelInterrupts(client)` makes its kernel client also call the `interrupt()` method of the kernels, like `JavaScriptKernel.interrupt()`. The extension calls it, and the extensions of kernels building on `JavaScriptKernel`, like the p5.js kernel, can call it too, since installing it twice does nothing. The `executorOptions`, `loopTimeout` and `maxStreamOutput` options of `JavaScriptKernel` configure the runtime when it starts: the extension sets them from the [settings](#settings), and the kernels building on `JavaScriptKernel` keep the defaults unless they pass them.
- `@jupyterlite/javascript-kernel-extension`: the JupyterLite extension registering the kernels, with their settings.

### Development install

Note: You will need NodeJS to build the extension package.

The `jlpm` command is JupyterLab's pinned version of
[yarn](https://yarnpkg.com/) that is installed with JupyterLab. You may use
`yarn` or `npm` in lieu of `jlpm` below.

```bash
# Clone the repo to your local environment
# Change directory to the jupyterlite-javascript-kernel directory
# Install package in development mode
pip install -e ".[dev]"
# Link your development version of the extension with JupyterLab
jupyter-builder develop . --overwrite
# Rebuild extension Typescript source after making changes
jlpm build
```

You can watch the source directory and run JupyterLab at the same time in different terminals to watch for changes in the extension's source and automatically rebuild the extension.

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
jlpm watch
# Run JupyterLab in another terminal
jupyter lab
```

With the watch command running, every saved change will immediately be built locally and available in your running JupyterLab. Refresh JupyterLab to load the change in your browser (you may need to wait several seconds for the extension to be rebuilt).

By default, the `jlpm build` command generates the source maps for this extension to make it easier to debug using the browser dev tools. To also generate source maps for the JupyterLab core extensions, you can run the following command:

```bash
jupyter lab build --minimize=False
```

The version reported by the kernel comes from
`packages/javascript-kernel/src/version.ts`, generated from `package.json` by
`jlpm version:sync`. `jlpm lint:check` verifies that it is up to date, and
`scripts/bump-version.py` regenerates it during releases. `jlpm lint:check`
also verifies that the ECMAScript edition reported by the kernel
(`ECMASCRIPT_EDITION` in `packages/javascript-kernel-runtime/src/executor.ts`)
is the latest edition of the installed `acorn` parser: update it together with
`acorn`.

### Running the tests

The UI tests in [`ui-tests`](ui-tests) use the kernels in a JupyterLite site with Playwright and Galata. See [`ui-tests/README.md`](ui-tests/README.md) to run them.

### Development uninstall

```bash
pip uninstall jupyterlite-javascript-kernel
```

In development mode, you will also need to remove the symlink created by `jupyter-builder develop`
command. To find its location, you can run `jupyter labextension list` to figure out where the `labextensions`
folder is located. Then you can remove the symlink named `@jupyterlite/javascript-kernel` within that folder.

### Packaging the extension

See [RELEASE](RELEASE.md)

# jupyterlite-javascript-kernel

[![Github Actions Status](https://github.com/jupyterlite/javascript-kernel/workflows/Build/badge.svg)](https://github.com/jupyterlite/javascript-kernel/actions/workflows/build.yml)
[![lite-badge](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)](https://jupyterlite.github.io/javascript-kernel/lab/index.html)

A JavaScript kernel for JupyterLite.

![a screenshot showing a notebook with the JavaScript kernel in JupyterLite](https://github.com/jupyterlite/javascript-kernel/assets/591645/c9085a6e-452e-4f77-8553-36133ee32389)

## Requirements

- JupyterLite 0.8 (`jupyterlite-core>=0.8,<0.9`), which the Python package installs

This kernel was originally maintained as part of the main JupyterLite repository, and was moved to its own repository for the JupyterLite 0.3.0 release.

## Install

Install the kernel in the Python environment which builds the JupyterLite site. It also installs `jupyterlite-core`:

```bash
pip install jupyterlite-javascript-kernel
```

Also install `jupyterlab-widgets` to show the [Jupyter Widgets](#jupyter-widgets):

```bash
pip install jupyterlab-widgets
```

Then build the site, in the folder of its notebooks and `jupyter-lite.json`, and serve it on http://localhost:8000 to try it:

```bash
jupyter lite build --contents .
jupyter lite serve
```

The site, in the `_output` folder, has the JavaScript kernels. See the [JupyterLite documentation](https://jupyterlite.readthedocs.io/en/stable/) to configure and deploy it.

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlite-javascript-kernel
```

## Runtime modes

The extension registers two JavaScript kernels:

| Kernel name         | Display name              | Runtime                                                                                                                                                                              |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `javascript`        | `JavaScript (IFrame)`     | Runs code in a hidden runtime `iframe` on the main page thread. Use this when your code needs browser DOM APIs like `document`, `window`, or canvas access through the page context. |
| `javascript-worker` | `JavaScript (Web Worker)` | Runs code in a dedicated Web Worker. Use this for stronger isolation and to avoid blocking the main UI thread.                                                                       |

Pick either kernel from the launcher or the notebook kernel selector in JupyterLite. The kernel name is the one saved in the `kernelspec` of the notebook metadata, like `{ "name": "javascript-worker", "display_name": "JavaScript (Web Worker)" }`, and the one to give in the URL of the REPL app of JupyterLite, like `repl/index.html?kernel=javascript`. Both kernels speak the same language, `javascript`, with the `.js` file extension.

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

A startup extension registered while kernels are running is applied to them
at once, even while a cell waits for a promise: its startup code does not
change the output limit and the interrupt of that cell. The running kernels
keep the registrations: when their runtime restarts, like a Web Worker
restarted after an interrupt or an iframe reloaded by a cell, the new runtime
gets the extensions registered since the kernel started, and not the ones
disposed.

A startup extension which throws does not stop the kernel: the next cell
prints `The startup extension "my-extension:lsp" failed, so the kernel runs
without it: Error: ...` on stderr, then runs as usual. So does an extension
whose `activate` does not settle within 30 s, like one awaiting a promise which
never resolves, with `TimeoutError: it did not activate within 30 s`: the
kernel starts without waiting for it.

### Runtime startup failures

When the runtime can not start, for example when the script of the Web Worker
does not load (offline, or blocked by a content security policy), or when the
iframe does not load within 10 s, the kernel still answers: the cells fail
with `RuntimeStartupError: JavaScript runtime failed to start: <reason>.
Restart the kernel to try again.` instead of staying at `[*]`, and the kernel
banner, in consoles and in the **Help** menu, shows the reason too.

### Worker mode limitations

Web Workers do not expose DOM APIs. In `JavaScript (Web Worker)`, APIs such as `document`, direct element access, and other main-thread-only browser APIs are unavailable. To draw, use an `OffscreenCanvas`, shown as an [image](#images), and for charts the [Vega-Lite helpers](#charts-and-diagrams), which the page renders. The errors of these globals, like `ReferenceError: document is not defined`, end with a [hint](#hints) suggesting `JavaScript (IFrame)`.

When the code of a cell does not stop after an interrupt, the kernel restarts the Web Worker, and the variables, functions, imports and widgets of the previous cells are lost. See [Interrupting code and loop protection](#interrupting-code-and-loop-protection). After `close()`, which stops the Web Worker, the cells fail with `The JavaScript runtime stopped: ... Restart the kernel.` instead of running forever.

### Iframe mode

In `JavaScript (IFrame)`, `document.write()` and `document.open()` replace the content of the runtime iframe, and the kernel keeps running, with the variables of the previous cells. When the code reloads the iframe or navigates it away, like with `location.reload()` or `location.href = '...'`, the kernel starts a new iframe and prints `The code reloaded or left the page of the iframe, so the runtime was restarted: ...`: the variables, functions, imports and widgets of the previous cells are lost. A cell still running at that moment fails with a `RuntimeReloadedError`.

The runtime iframe is rendered but invisible: it is 800 × 600 pixels, fixed at the top left of the page and hidden with `visibility: hidden`, out of reach of the mouse, the keyboard and the screen readers. So the DOM code of the cells works like on a visible page: the elements they append have a layout, like `offsetWidth`, `getBoundingClientRect()` and `IntersectionObserver` entries, `innerWidth` and `innerHeight` are 800 and 600, and `requestAnimationFrame()` runs the animations. To show what a cell draws, make the element, like a canvas, the result of the cell, or display it: it is shown [live](#live-dom-elements), moved to the output. When the code of a cell focuses an element of the iframe, like with `input.focus()`, the page takes the focus back, without scrolling, so the keyboard keeps going to the notebook. When this happens while the page is in the background, like from a timer, the page takes the focus back when it comes to the front again.

The kernel calls the runtime of the iframe directly, from the page: it does not handle the messages posted to the window of the iframe, so other windows, like a page embedding JupyterLite, can not run code in the kernel with `postMessage()`.

### Import side effects in iframe mode

In `JavaScript (IFrame)`, user code and imports execute in the runtime iframe scope.

By default, module-level side effects stay in the runtime iframe. To show what a library draws, give it an element and make the element the result of the cell, or display it: the output shows the element [live](#live-dom-elements). To intentionally affect the main page (`window.parent`), access it directly.

Cell declarations like `var`, `let`, `const`, `function`, and `class` remain in the runtime scope. Host-page mutations happen when your code (or imported code) explicitly reaches `window.parent`.

#### Example: canvas-confetti

```javascript
import confetti from 'canvas-confetti';

const canvas = document.createElement('canvas');
canvas.width = 600;
canvas.height = 300;

const fire = confetti.create(canvas);
fire({ particleCount: 100, spread: 70, origin: { y: 0.6 } });

canvas;
```

#### Example: p5.js

```javascript
import p5 from 'p5';

const mount = document.createElement('div');
const sketch = new p5(p => {
  p.setup = () => {
    p.createCanvas(240, 120);
  };
  p.draw = () => {
    p.background(240);
    p.circle(p.mouseX, p.mouseY, 20);
  };
}, mount);

mount;
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
- A cell which is an object literal, like `{ a: 1, b: 2 }`, shows the object, instead of running a block, and a cell which destructures one, like `{ a, b } = point`, assigns the names.
- The `export` keywords are ignored, so the code of a module can be pasted in a cell: `export const x = 1` declares `x`, `export default (a + b)` evaluates the expression, the `export { ... }` lists are removed, and `export ... from '...'` loads the module.
- The `using` and `await using` declarations dispose their resource at the end of the cell, like at the end of a module, and the name is kept for the next cells.
- `import.meta` is not available, since the cells are not modules: it fails with `SyntaxError: Cannot use 'import.meta' outside a module` at its location.
- The cells can use top-level `await` and the `import` statements of the modules, and they run in sloppy mode, so the names reserved only in strict mode, like `package` or `interface`, can be declared, also in a cell with `import` or `export` statements.
- The declarations named like a global of the browser keep their value: after `const name = { a: 1 }`, `name.a` is `1` in the next cells, instead of `window.name` turning the value to a string, and `function onmessage(event) {}` installs the event handler. The event handlers, like `onmessage`, hold what their setter keeps, like a `var` in a script: a function, or `null` for any other value, so `const onmessage = 5` makes `onmessage` `null`. The functions of the cell use the same global: after `let name = 'Ada'; function rename(n) { name = n }`, `rename('Bob')` changes `name` for every cell. The globals which can not be replaced, like `location`, `top`, `window` and `document` in `JavaScript (IFrame)`, can not be declared: `const location = 'Paris'` fails with `SyntaxError: 'location' is a built-in global and cannot be redeclared in a cell; pick another name`, instead of navigating the iframe away. As in a script, a `var` declaration without a value, like `var window;`, `var name;` or `var onmessage;`, keeps the global.
- `_` holds the result of the last cell which showed one, like in the Node.js REPL: after a cell showing `42`, `_ + 1` is `43`. A cell without a value, or ending with a semicolon, keeps it. `_error` holds the last error: the error of the last cell which failed, or the last error printed later as `Uncaught` (see [Errors](#errors)), like `_error.stack` after a failure. Assigning `_` or `_error`, declaring them, or importing `_`, like `import _ from 'lodash-es'`, replaces them with that value for good, when the assignment, the declaration or the import runs, so the libraries named `_` keep working, and `delete _` removes it. A script of the page looking for a global `_`, like a UMD bundle looking for Underscore, finds the last result: assign `_` before loading it. The [silent requests](#execute-requests-of-extensions) of the extensions do not change them.

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
- the imports with a `type` attribute get no `/+esm` either, which serves JavaScript: `import data from 'some-package/data.json' with { type: 'json' }` loads `https://cdn.jsdelivr.net/npm/some-package/data.json`
- the sources starting with `npm/` or `gh/` keep their path: `gh/user/repo/file.js` loads `https://cdn.jsdelivr.net/gh/user/repo/file.js`
- a query or a hash stays at the end, after `/+esm`
- the URLs (`https://...`), the protocol-relative URLs (`//...`), the relative and absolute paths (`./`, `../`, `/`) and the import map specifiers (`#...`) are left unchanged

The packages load at run time, so the magic imports need a network connection to the CDN. When a package can not be loaded, the error says why, like a typo in its name or a CDN which can not be reached (see [Hints](#hints)). The CDN, the rules and the magic imports themselves can be changed in the [settings](#settings), for example to use [esm.sh](https://esm.sh/) or packages hosted with the JupyterLite site. The modules loaded by name by the [startup extensions](#kernel-startup-extensions) use the same rules.

The imports behave like in an ES module:

- `import()` loads the package names like the `import` statements, also in functions and with a name computed when the cell runs: `const { capitalize } = await import('lodash-es')` loads the same module as `import { capitalize } from 'lodash-es'`
- importing a name that the module does not export, like a typo, throws a `SyntaxError` pointing at the name, like `The requested module 'lodash-es' does not provide an export named 'capitalise'`, and the cell stops before binding the other names of the statement. A default import of a module without a default export throws the same error for `default`
- the import attributes are kept, so JSON modules load with `import data from './data.json' with { type: 'json' }`
- the names exported as strings are imported with `import { "kebab-name" as kebab } from '...'`
- `require()` is not available, and throws a `ReferenceError` suggesting `import` instead. It is only installed when the page has no `require` of its own, like RequireJS. It is a global function of the iframe or the Web Worker, so `typeof require` is `'function'` for the cells and for the libraries they load: a library checking for CommonJS with `typeof require` without catching the error fails with this `ReferenceError`. `delete globalThis.require` removes it

## Interrupting code and loop protection

The stop button of the notebook toolbar, **Kernel > Interrupt Kernel** and <kbd>I</kbd>, <kbd>I</kbd> stop the running cell with `KeyboardInterrupt: Execution interrupted`, and cancel the cells waiting to run. The variables of the cell are kept. An interrupt also clears the `setTimeout()` and `setInterval()` timers created by the cells, so it stops the background intervals, even when no cell is running.

- A cell waiting for a promise that never settles, an `await` in a loop and a sleep loop stop at once, in both kernels.
- `JavaScript (IFrame)` runs on the thread of the page, so a synchronous loop freezes JupyterLite: the page can not even handle the stop button. A loop running for more than 10 s without letting the page respond is stopped with a `LoopTimeoutError`, like `The while loop at line 2 of In[3] ran for more than 10 s without letting the page respond, so it was stopped.`, and the kernel keeps its state. The time spent waiting in `alert()`, `confirm()` and `prompt()` does not count. Change the limit for the next kernels with the **Loop timeout (ms)** [setting](#settings), in a cell with `Jupyter.loopTimeout = 30000` (in ms, 0 turns it off), or with the `loopTimeout` option of the kernel, or run long computations in `JavaScript (Web Worker)`.
- `JavaScript (Web Worker)` runs off the page thread, so the page stays responsive. When the page is cross-origin isolated (served with the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` or `credentialless` headers), the loops stop at once and the state is kept. Otherwise, code that does not yield is stopped by restarting the Web Worker after 2 s, or at once with a second interrupt: the cell explains that the variables, functions, imports and widgets of the previous cells are lost.

`KeyboardInterrupt` and `LoopTimeoutError` can be caught, but the loops keep throwing them, `KeyboardInterrupt` until the next execution or the next message of a widget, like a click on a button, whose callbacks run their loops as usual, and `LoopTimeoutError` until the page handles a task, and the cell is reported as failed even when its code caught them.

Limitations:

- The loops in the code of imported modules, in `eval()` and `new Function()` strings, and the long calls to built-in functions are not stopped in `JavaScript (IFrame)`, and in `JavaScript (Web Worker)` they only stop when the Web Worker is restarted.
- `prompt()` in `JavaScript (IFrame)` is the native dialog of the browser, which blocks the page until it is closed.
- The sketch of the p5.js kernel shown with `%show` runs in its own iframe, without loop protection.
- An interrupted cell is abandoned, not unwound: its `finally` blocks do not run, and a pending `fetch()` may still resume it later. Its output then goes to the last cell that ran.
- The guard checked by the loops makes the loops doing almost nothing about twice as slow. The loops doing real work, and the array methods like `map()`, are barely affected.

## Rich output

The last expression of a cell is shown as its result. The values are printed like with `util.inspect` in Node.js. The objects of the web APIs show their state, like `Blob { size: 2, type: 'text/plain' }`, or the `status` and the `headers` of the `Response` of `await fetch(url)`. In the console and inside other values, the DOM nodes show as their opening tag, like `{ el: <div id="main"> }`, while an element that is the result of a cell is shown [live](#live-dom-elements) in `JavaScript (IFrame)`.

The data that JSON can represent as it is, like objects and arrays of strings, numbers, booleans and `null`, is also shown as an interactive tree. The values JSON would change, with `NaN`, `Infinity`, `undefined`, functions, symbols or BigInt, the objects without own properties, like a `Blob`, the objects of the web APIs, like an `Event`, and the large values, with more than 10,000 items or 1 MB of JSON, are shown as text only: the text lists the first 100 items of a large array, which is not saved in full in the notebook.

`display(value, options)` shows values in the middle of a cell. With the `id` option (`true` to generate one), it returns a handle to update the output later, also from other cells:

```javascript
const task = display.text('Starting...', { id: true });
await new Promise(resolve => setTimeout(resolve, 1000));
task.update('Done!');
```

The `metadata` option sets the metadata of the output, and `live: false` shows a snapshot of a DOM element instead of the [element itself](#live-dom-elements). `handle.display(value)` shows a new output, updated together with the other outputs of the handle.

The helpers of `display` show content for the common MIME types:

- `display.html`, `display.markdown`, `display.svg`, `display.latex` and `display.text` take a string, or are used as tagged templates: ``display.markdown`**${name}**` ``
- `display.json(value)` shows an interactive JSON tree, or the text of the values JSON can not represent, like above
- `display.png(bytes, { width, height })` and `display.jpeg(...)` show images, from their bytes, base64, a `Blob`, or a drawing, an `OffscreenCanvas`, an `ImageBitmap` or an `ImageData`, encoded in their format
- `display.vegalite(spec)`, `display.vega(spec)` and `display.mermaid` show [charts and diagrams](#charts-and-diagrams)
- `display.mime(bundle)` shows a MIME bundle, like `{ 'text/html': '<b>Hi</b>', 'text/plain': 'Hi' }`. A value with a `data` object of MIME types, like `{ data: { 'text/html': '<b>Hi</b>' } }` or `{ data: { 'text/vnd.mermaid': 'graph TD; A-->B' } }`, is also shown as its MIME bundle, while `{ data: { '2024/01': 5 } }` is shown as data

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

### Images

An `OffscreenCanvas`, an `ImageBitmap`, an `ImageData`, like the pixels of `getImageData()`, and a `Blob` of a PNG, JPEG, GIF, WebP or SVG image are shown as images, as the result of a cell or with `display()`. The drawings are encoded as PNG, and the text of the output describes them, like `<OffscreenCanvas 240x80>`. In `JavaScript (Web Worker)`, which has no DOM, an `OffscreenCanvas` is the way to draw:

```javascript
const canvas = new OffscreenCanvas(240, 80);
const context = canvas.getContext('2d');
context.fillStyle = 'teal';
context.fillRect(20, 20, 200, 40);
canvas;
```

```javascript
const logo = await (await fetch('https://example.com/logo.png')).blob();
display(logo);
```

The images are encoded asynchronously, from the pixels of the drawing when it is displayed: the outputs displayed after an image wait for it, so they keep their order, and the cell finishes once its images are shown. A `prompt()` called while an image is still being encoded shows its input box first: the image, and the text printed after it, show up once the user answered. `display.png()` and `display.jpeg()` encode the drawings in their format, like `display.jpeg(canvas, { width: 120 })`, and the [`Image` widget](#files-dates-and-tags) takes them too. In `JavaScript (IFrame)`, a canvas element is shown [live](#live-dom-elements), and saved as an image.

### Live DOM elements

In `JavaScript (IFrame)`, an element which is the result of a cell, or given to `display()`, is shown live: the output shows the element itself, moved from the runtime iframe to the notebook, instead of a copy of its HTML. It keeps its event listeners and its state, and shows its later changes:

```javascript
const button = document.createElement('button');
let clicks = 0;
button.textContent = 'Clicks: 0';
button.onclick = () => (button.textContent = `Clicks: ${++clicks}`);
button;
```

So a button runs its `onclick` handler, a `<div>` updated by `setInterval()` ticks, the input of a text field stays in it, a canvas keeps animating, also inside a `<div>`, and the charts of libraries like d3 or Observable Plot show their tooltips:

```javascript
import * as Plot from '@observablehq/plot';

const letters = [...'JUPYTER'].map((letter, i) => ({ letter, count: i + 1 }));
Plot.barY(letters, { x: 'letter', y: 'count', tip: true }).plot();
```

- The notebook saves a snapshot of the element, taken when it is shown: its HTML, with the canvases in it as images, like the one of a p5.js sketch in its `<div>`, and the image of a canvas. The output shows this snapshot when the element is gone: after a restart of the kernel, in a notebook opened on a new page or from a file, and in the other Jupyter frontends. A notebook closed and opened again while its kernel runs shows the elements again, in their current state: the kernel keeps the last 1,000 elements shown.
- An element is in one place at a time: when several outputs show it, like after `display(el)` twice, the last one has it and the others show their snapshot. When that output is cleared, like when its cell runs again, the element goes back to the previous output showing it.
- The element leaves the document of the iframe: `document.querySelector()` does not find it anymore, so keep a reference to it, and its `ownerDocument` is the document of the notebook. The style sheets of the iframe document, like a `<style>` added to `document.head`, do not apply to it, while the styles of the notebook for the HTML outputs do: use inline styles, or a `<style>` or a `<link rel="stylesheet">` in the element, which applies to the whole page, like in an HTML output.
- Its mouse, pointer and keyboard events are also sent to the document of the iframe, where they bubble to its window: the listeners added by the code of the cells to `document` or `window`, like the ones of p5.js for `mouseX` and `mouseY`, get them, with the document as their target, as if the element was still in the iframe. The touch events are not. The keys typed while an element of the output has the focus, like a canvas with a `tabindex`, still run the shortcuts of the notebook, like <kbd>A</kbd> to insert a cell, unless it is a text field.
- The root, the `<head>` and the `<body>` of the iframe document, and the elements of the page, like the ones of `window.parent.document`, are shown as a snapshot, like an element displayed with `display(el, { live: false })`. An untrusted notebook shows the snapshots too.
- `JavaScript (Web Worker)` has no DOM, so it shows no live elements.

### Charts and diagrams

The page renders [Vega-Lite](https://vega.github.io/vega-lite/) and [Vega](https://vega.github.io/vega/) charts, and [Mermaid](https://mermaid.js.org/) diagrams: the kernel only sends their spec, so they work in both kernels, also in `JavaScript (Web Worker)` without a DOM, and without importing a library. `display.vegalite(spec)` shows a Vega-Lite chart, like a bar chart of an array of records, with a tooltip:

```javascript
const sales = [
  { month: 'Jan', amount: 28 },
  { month: 'Feb', amount: 55 },
  { month: 'Mar', amount: 43 }
];

display.vegalite({
  data: { values: sales },
  mark: 'bar',
  encoding: {
    x: { field: 'month', type: 'nominal', sort: null },
    y: { field: 'amount', type: 'quantitative' },
    tooltip: [{ field: 'month' }, { field: 'amount' }]
  }
});
```

The page can also load the data of a chart from a URL, like a CSV file:

```javascript
display.vegalite({
  data: {
    url: 'https://cdn.jsdelivr.net/npm/vega-datasets@2/data/seattle-weather.csv'
  },
  mark: 'line',
  encoding: {
    x: { field: 'date', timeUnit: 'yearmonth', type: 'temporal' },
    y: { field: 'temp_max', aggregate: 'mean', type: 'quantitative' }
  }
});
```

- a cell whose result is a spec with the `$schema` of Vega-Lite 3 to 5, like `https://vega.github.io/schema/vega-lite/v5.json`, or of Vega 5, is shown as a chart too
- `display.vega(spec)` shows a Vega chart
- the specs are sent as JSON: the dates of the data become ISO strings, which Vega-Lite reads with `type: 'temporal'`
- with `{ id: true }`, the handle updates the chart with a new spec, like `handle.update(newSpec)`
- `display.mermaid(source)` shows a Mermaid diagram, also as a tagged template: ``display.mermaid`graph LR; Fetch-->Parse-->Chart` ``

The renderers of other charts, like the one of Plotly (`application/vnd.plotly.v1+json`), need their JupyterLab extension in the JupyterLite deployment: `display.mime()` then shows them.

## Console

The `console` methods print to the outputs of the cell, with the values formatted like in Node.js:

- `console.log`, `console.info` and `console.debug` print to the standard output, `console.error`, `console.warn` and `console.trace` to the standard error
- the format specifiers `%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O` and `%c` are replaced, like `console.log('%s is %d', 'answer', 42)`
- `console.table` shows a table, `console.dir` an object with options like `{ depth }`
- `console.group`, `console.groupCollapsed` and `console.groupEnd` indent the messages
- `console.count`, `console.countReset`, `console.time`, `console.timeLog`, `console.timeEnd` and `console.assert` work like in the browser
- `console.clear` clears the outputs of the cell
- consecutive writes to the standard output or the standard error are sent together, at most every 50 ms, so printing thousands of lines in a loop is fast. The outputs keep their order: the pending text is sent before any rich output, error, widget message or prompt, and when the cell finishes. In the Web Worker kernel, a long loop shows its output while it runs, and so does a loop of a cell after a `console.log`, like `console.log('Computing...')` before a long computation. The text printed before a loop stopped by a restart of the Web Worker is shown too, and so is the text printed while the code of a cell reloads the iframe
- the code running after its cell prints in the outputs of the cell which started it, even after other cells ran: the callbacks of `setTimeout`, `setInterval` and `requestAnimationFrame` print in the cell which created them, so an interval or an animation keeps its outputs in its own cell, and the callbacks of the [widgets](#jupyter-widgets), like a click handler, print in the cell which registered them. The other code running later, like the code after an `await` in a callback, an event listener or the callback of a promise, prints in the cell that ran last. When a cell runs again, the notebook forgets the outputs of its previous run: the timers of that run which still print are not shown anymore, interrupt the kernel to stop them
- a cell prints at most 5,000,000 characters on the standard output and the standard error, about 50,000 lines of 100 characters: the rest is not shown, and a notice is printed instead. This stops a runaway loop of `console.log` before it freezes the page. Change the limit with the **Output limit (characters)** [setting](#settings). Each cell has its own count, which starts again when the cell runs again, or when the cell calls `console.clear()` or `clearOutput()`: an interval which reached the limit stays silent while the other cells run and print, and the clicks of a button print in the cell which registered it. An async callback captured by an `Output` widget has its own limit too, for the outputs the widget shows after an `await`, so each click of a button can print again. The errors thrown later by a cell that reached the limit, in a timer or an event listener, are printed in the console of the browser

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
- The last error, of a cell or printed later, is in `_error`, to look at it in the next cell (see [Cells](#cells)).
- The `raises-exception` tag of a cell does not let **Run All** go on after its error. JupyterLab asks the kernel not to stop at the error of such a cell (with `stop_on_error: false`), but JupyterLite cancels the cells waiting to run as soon as a cell fails, whatever the request asks. This is a limitation of JupyterLite, not of the kernel. In `JavaScript (Web Worker)`, **Run All** stops at the first cell which fails. In `JavaScript (IFrame)`, which runs the cells on the page, the cells after it can still run, when the cell fails before JupyterLite received them.

The columns can differ slightly between browsers, which point at different parts of the expression that failed.

### Hints

The common errors end with a hint, in a dim line after an empty line. The hints are only lines of the traceback: the name and the message of the error are kept, so the `ename` and `evalue` of the reply do not change.

```
In[1]:1
consle.log(1)
^

ReferenceError: consle is not defined
    at In[1]:1:1

Did you mean: console?
```

- A name which is not defined, close to a global or to a name declared by the cells, suggests it: `Did you mean: console?`.
- A member which is not a function, or read on `undefined`, close to a member of its object, suggests it: `Math.flor(2.5)` gives `Did you mean: Math.floor?`. The object is read from the global scope, so the variables of the functions get no suggestion, and a variable which is `undefined`, like the parameter `node` in `node.width`, gets none either.
- A `fetch()` which got no response (`TypeError: Failed to fetch`) explains that the server could not be reached, or does not allow the requests of the page with [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) headers.
- A failed [magic import](#imports) points at the source of the import, and checks its URL with a `HEAD` request to tell why: `The package 'lodahs-es' was not found on https://cdn.jsdelivr.net/ (404): check its name on npmjs.com.`, `The package 'lodash-es' has no version 99 on ...`, `The package 'lodash-es' has no file ... on ...`, or `The CDN https://cdn.jsdelivr.net/ could not be reached: the magic imports need a network connection to it.` It then reminds that the CDN is set in the [settings](#settings). When the module was found, the error comes from its code, and is shown as is. The URL is only checked when the error is shown: the code which handles the failure, like `try { m = await import('a') } catch { m = await import('b') }`, gets the error at once.
- In `JavaScript (Web Worker)`, the globals of the pages, like `document`, `window`, `Image`, `alert` or `localStorage`, suggest the IFrame kernel: `document is not available in the JavaScript (Web Worker) kernel, which has no DOM: use Kernel > Change Kernel… > JavaScript (IFrame), or an OffscreenCanvas to draw.`

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

- `out.capture(callback, options?)`, or `out.capture(options)(callback)`, returns a function which runs `callback` with its outputs (the `console`, `display()`, `clearOutput()`) shown in the widget. The outputs of an async callback after an `await` are captured too, until its promise settles, and so are the ones of the timers it creates, like a `setTimeout()` callback: while it runs, the outputs of the other code running outside of the cells, after an `await`, also go to the widget, but not the ones of a cell running. An async callback started by a cell stops capturing when the next cell runs, and any async callback when the kernel is interrupted: its outputs then go to the cell that ran last. To update a widget from an endless loop, capture each step instead, like `setInterval(out.capture(() => console.log(new Date())), 1000)`. When a callback runs again before the previous run ended, like a button clicked twice, the widget shows the outputs of both. With the `clearOutput` option, the outputs of the widget are removed first, when the next output arrives with `wait`. The errors of the callback go to the cell which registered it.
- `out.appendStdout(text)` and `out.appendStderr(text)` add some text, and `out.appendDisplayData(value, metadata?)` adds a value shown like `display()` shows it, like a widget, or a MIME bundle like `{ 'text/html': '<b>Hi</b>' }`. The images which are encoded asynchronously, like an `OffscreenCanvas`, are shown as their text there: show them with `display()` in `out.capture()`
- `out.clearOutput({ wait })` removes the outputs of the widget, with `wait` when the next output arrives

The kernel handles the messages of the widgets, like the clicks of a button or the new value of a slider moved by the user, between the cells: JupyterLite gives the messages of the frontend to the kernel one at a time, in order, so they wait while a cell runs, also while it waits in an `await`. A cell looping over the value of a widget does not see the slider move until it ends:

```javascript
const slider = new Jupyter.widgets.IntSlider();
display(slider);

// Moving the slider while the loop runs prints 0 until the loop ends
for (let i = 0; i < 50; i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(slider.value);
}
```

Use the callbacks of the widgets instead, like `slider.observe()`, or a `setInterval()` timer, which run between the cells and see the new values.

When a notebook is closed and opened again while its kernel keeps running, like with File > Close Tab and a double-click in the file browser, its widgets show again, with their current values, and keep syncing with the kernel: the kernel answers the widget manager of the notebook with the state of the live widgets, including the bytes of the `Image`, `Video` and `Audio` widgets and of the uploaded files. The widgets are lost when the kernel restarts.

Widgets also work when JupyterLite is served over plain http, for example on a LAN, where the browser hides some APIs like `crypto.randomUUID` (only `prompt()` in `JavaScript (Web Worker)` needs the service worker, which needs `https` or `localhost`).

### Selection widgets

The options of `Dropdown`, `RadioButtons`, `Select`, `ToggleButtons`, `SelectionSlider`, `SelectMultiple` and `SelectionRangeSlider` are values, labelled with their string, `[label, value]` pairs, or an object of the values by label. Select an option with its `value`, its `label` or its `index`:

```javascript
const { Dropdown } = Jupyter.widgets;

const size = new Dropdown({
  options: [
    ['Small', 1],
    ['Medium', 2],
    ['Large', 3]
  ],
  value: 2,
  description: 'Size'
});
size.observe(({ new: value }) => console.log('Size:', value), 'value');
size;
```

- `value` is the value of the selected option (`2`), `label` its label (`'Medium'`), and `index` its index, null when nothing is selected. Like ipywidgets, the frontend syncs the index: `value` and `label` follow it, and their observers get the value and the label. The values can be anything, like objects or bigints, and are compared like `Array.includes()`
- a value or a label which is not an option throws a `RangeError` (`Invalid selection: value not found`)
- when the `options` change, the selected value stays selected if it is still an option, or else the first option is selected
- `SelectMultiple` and `SelectionRangeSlider` select a list of values, labels and indices. The range of a `SelectionRangeSlider` has two options, the lower one first, or else it throws a `RangeError`

### Layout and style

Every widget with a view has a `layout`, and a `style` of its kind, like a `ButtonStyle` for a `Button` (the boxes, the media widgets `Image`, `Video` and `Audio`, and `Output` have no style). Their properties, like the CSS properties of the layout, can be set when the widget is created, as plain objects, or later:

```javascript
const { Button, IntSlider } = Jupyter.widgets;

const button = new Button({
  description: 'Save',
  style: { button_color: 'lightgreen' },
  layout: { width: '200px', border: '1px solid gray' }
});
button.tooltip = 'Save the results';
button.layout.height = '40px';
display(button);

const slider = new IntSlider({ description: 'A long description' });
slider.style.description_width = 'initial';
slider;
```

- `layout.border` sets the four borders, `border_top`, `border_right`, `border_bottom` and `border_left`
- assigning a plain object to `layout` or `style` replaces them with new ones
- `tooltip`, `tabbable`, and `addClass(name)` and `removeClass(name)` for the CSS classes of the view, are available on all these widgets
- the properties given as `undefined`, like `new IntSlider({ max: options.max })` without a `max`, keep their default, and setting a property to `undefined` keeps its value

### Values in their bounds

Like ipywidgets, the numeric widgets keep their value in their bounds, so the value in the kernel is the one the widget shows: `new IntSlider({ value: 150 })` has the value 100, and lowering `max` lowers the value. The bounds of the constructor are applied first, so `new IntSlider({ value: 150, max: 200 })` keeps 150. The integer widgets round their values (`slider.value = 3.7` gives 4), and the widgets throw a `RangeError` when `min > max` (`setting min > max`), or when the lower value of a range slider is above the upper one.

### Files, dates and tags

A `FileUpload` button brings local files into the kernel, like a CSV file. Its `value` is the list of the picked files, each one with its `name`, `type`, `size`, `last_modified` date and `content`, the bytes of the file as a `Uint8Array`:

```javascript
const { FileUpload } = Jupyter.widgets;

const upload = new FileUpload({ accept: '.csv', multiple: false });
upload.observe(({ new: files }) => {
  for (const file of files) {
    const text = new TextDecoder().decode(file.content);
    console.log(`${file.name}: ${text.split('\n').length} lines`);
  }
}, 'value');
upload;
```

- the button shows the number of picked files, like `Upload (1)`; `accept` filters the files, like `.csv,.txt` or `image/*`, and `multiple` picks several at once
- `upload.value = []` forgets the files

The date and time pickers show the inputs of the browser:

```javascript
const { DatePicker, TimePicker, DatetimePicker, VBox } = Jupyter.widgets;

const day = new DatePicker({
  description: 'Day',
  value: new Date('2024-05-01')
});
const time = new TimePicker({ description: 'Time', value: '09:30' });
const meeting = new DatetimePicker({
  description: 'Meeting',
  value: new Date()
});
new VBox({ children: [day, time, meeting] });
```

- the `value` of a `DatePicker` is a `Date` at midnight UTC, like `new Date('2024-05-01')`, so `day.value.toISOString().slice(0, 10)` is the picked date. Another `Date` gives the date of its day in the time zone of the browser, like `new Date()` for today
- the `value` of a `DatetimePicker` is a `Date`, shown in the time zone of the browser. The `NaiveDatetimePicker` sends its fields to the frontend without a time zone, like the naive datetimes of Python
- the `value` of a `TimePicker` is a string, like `'09:30'`, with the seconds and the milliseconds when they are not zero, like `'09:30:15.250'`, as the time inputs of the browsers show it
- the values are null when nothing is picked. A string or a number given as a date is turned into a `Date`. Like the numeric widgets, `min` and `max` keep the value in their bounds, and a `RangeError` is thrown when `min > max`. `step` is in days for a `DatePicker`, in seconds for a `TimePicker`, or `'any'`
- the dates are `Date` objects of the cells, so `day.value instanceof Date` holds in `JavaScript (IFrame)` too

`TagsInput`, `ColorsInput`, `IntsInput` and `FloatsInput` edit a list of strings, colors or numbers: type a tag in the widget to add it, or click its cross to remove it:

```javascript
const { TagsInput, IntsInput } = Jupyter.widgets;

const fruits = new TagsInput({
  value: ['apple'],
  allowed_tags: ['apple', 'banana', 'cherry'],
  allow_duplicates: false
});
fruits.observe(({ new: tags }) => console.log(tags), 'value');
display(fruits);
display(new IntsInput({ value: [1, 2, 3], min: 0, max: 10 }));
```

- `allowed_tags` are suggested while typing, and the other tags are rejected, also when the kernel sets them (`Tag value pink is not allowed`), and the numbers out of `min` and `max` throw a `RangeError`
- `tag_style` styles the tags (`'primary'`, `'success'`, `'info'`, `'warning'`, `'danger'`), and `format` shows the numbers, like `'.2f'`

`Video` and `Audio` play the bytes of a video or a sound, like `Image` shows the bytes of an image, with `autoplay`, `loop` and `controls`, all true by default. `Image.fromUrl(url)`, `Video.fromUrl(url)` and `Audio.fromUrl(url)` show the media of a URL instead:

```javascript
const { Video } = Jupyter.widgets;

Video.fromUrl('https://example.com/movie.mp4', {
  autoplay: false,
  width: '320'
});
```

The media widgets also take a `Blob`, like the one of `await (await fetch(url)).blob()`, and `Image` takes a drawing, an `OffscreenCanvas`, an `ImageBitmap` or an `ImageData`, encoded in its `format`, PNG by default, like [`display()`](#images) does. The widget shows it once read or encoded, with the format of the `Blob`, and keeps its previous value meanwhile:

```javascript
const canvas = new OffscreenCanvas(240, 80);
canvas.getContext('2d').fillRect(20, 20, 200, 40);
// Not destructured, to keep the Image constructor of the DOM
const image = new Jupyter.widgets.Image({ value: canvas, width: '240' });
image;
```

### Buttons and custom messages

`button.onClick(callback)` calls the callback with the button, like `button.onClick(b => { b.description = 'Clicked'; })`, and `button.offClick(callback)` removes it.

Every widget can exchange custom messages with its model in the frontend: `widget.send(content, buffers?)` sends one, and `widget.onMsg((content, buffers) => ...)` handles the ones of the frontend (`offMsg` removes the handler), like the clicks of a button. To use the widgets of a library installed in JupyterLite, subclass `Widget`, or `DOMWidget` for a widget with a view, with the names of its model and view:

```javascript
const { DOMWidget } = Jupyter.widgets;

class Counter extends DOMWidget {
  static modelName = 'CounterModel';
  static modelModule = 'my-widgets';
  static modelModuleVersion = '1.0.0';
  static viewName = 'CounterView';
  static viewModule = 'my-widgets';
  static viewModuleVersion = '1.0.0';

  // The default state: its properties get accessors, like counter.count
  _defaults() {
    return { ...super._defaults(), count: 0 };
  }
}

const counter = new Counter({ count: 1 });
counter.onMsg(content => console.log('The view says', content));
counter;
```

### Interact

`interact(fn, controls, options?)` makes the controls of a function, like `interact()` in ipywidgets: a widget for each of its parameters, and the outputs of the function under them, which run again when a control changes. As JavaScript has no keyword arguments, the function gets the values of the controls in one object, by name:

```javascript
const { interact } = Jupyter.widgets;

function draw({ r, color }) {
  display.svg`<svg width="220" height="220"><circle cx="110" cy="110" r="${r}" fill="${color}"/></svg>`;
  return `A ${color} circle of radius ${r}`;
}

display(interact(draw, { r: [5, 100], color: ['red', 'green', 'blue'] }));
```

Each value of `controls` gives a control, like in ipywidgets:

- `[min, max]` or `[min, max, step]`: an `IntSlider`, or a `FloatSlider` when one of the numbers is not an integer, with the value in the middle. An array of two or three numbers is always a range: for a dropdown of numbers, pass `[label, value]` pairs
- a number: a slider from `-value` to `3 * value`
- a boolean: a `Checkbox`
- a string: a `Text`
- an array of values or of `[label, value]` pairs, or an object of the values by label: a `Dropdown`
- a widget with a value, like `new IntSlider({ max: 5 })`: the widget itself, labelled with the name when it has no description
- `fixed(value)`: the value as is, without a control

The function runs in an `Output` widget, like with `out.capture()`: its `console` output and its `display()` calls replace the ones of the previous run, the value it returns is shown under them like `display()` shows it, unless it is `undefined` or `null`, and its errors are printed there too. An async function is awaited, and the result of a run which ends after a newer run started is not shown. Its outputs after an `await`, and the ones of the timers it creates, like a `setTimeout()` callback, go to the `Output` widget until it ends, like with `out.capture()`.

`interact()` returns the widget, a `VBox` of the controls and the `Output`, which shows when it is the last expression of the cell, or with `display()`. Its `result` is the value returned by the last run, `kwargs` the values it got, `kwargs_widgets` the controls, `out` the `Output` widget, and `update()` runs the function again. The function also gets the widget as `fn.widget`. The options are:

- `manual`: only run the function when a button is clicked, labelled with `manual_name` ('Run Interact' by default). `interact.manual(fn, controls)`, or `interact_manual()`, is a shortcut. A text box then also runs it when Enter is pressed. The button is disabled while the function runs, until its promise settles for an async function, or until the kernel is interrupted
- `continuous_update: false`: the sliders and the text boxes made from the controls send their value when they are released, or when Enter is pressed, instead of while they change
- `clear_output: false`: keep the outputs of the previous runs
- `auto_display: false`: do not show the value returned by the function

`interactive(fn, controls, options?)` makes the same widget without showing the value returned by the function, like in ipywidgets: read it from its `result`. `interactive_output(fn, controls)` takes existing widgets, by name, and returns only the `Output` widget, for a layout of your own:

```javascript
const { interactive_output, HBox, IntSlider, VBox } = Jupyter.widgets;

const a = new IntSlider({ value: 2, description: 'a' });
const b = new IntSlider({ value: 3, description: 'b' });
const out = interactive_output(
  ({ a, b }) => console.log(`${a} + ${b} = ${a + b}`),
  { a, b }
);
display(new VBox({ children: [new HBox({ children: [a, b] }), out] }));
```

### Links and waiting for changes

`jslink()` and `jsdlink()` link two widgets in the frontend, so they keep working without the kernel. `link(source, target, transform?)` and `dlink(source, target, transform?)` link them in the kernel instead, like `link()` and `dlink()` of traitlets, so the values can be changed on their way: `dlink()` from the source to the target, with a function, and `link()` both ways, with a pair of functions `[forward, backward]`. The target gets the value of the source at once, and `unlink()` stops them:

```javascript
const { FloatSlider, FloatText, link } = Jupyter.widgets;

const celsius = new FloatSlider({ max: 100, description: 'Celsius' });
const fahrenheit = new FloatText({ description: 'Fahrenheit' });
const temperature = link(
  [celsius, 'value'],
  [fahrenheit, 'value'],
  [c => (c * 9) / 5 + 32, f => ((f - 32) * 5) / 9]
);
display(celsius);
display(fahrenheit);
```

`widget.changed(name?)` returns a promise of the next value of a property (`'value'` by default), `widget.changes(name?)` an async iterator of its next values, and `button.clicked()` a promise of the next click, like the `wait_for_change()` of the asynchronous widgets of ipywidgets. As the kernel handles the messages of the widgets between the cells, a cell awaiting them waits for the changes made by the kernel, like in a timer, but not for the ones made by the user: start an async function without awaiting it, which runs on after the cell, like ipywidgets does with an asyncio task:

```javascript
const { Button, IntSlider } = Jupyter.widgets;

const slider = new IntSlider({ description: 'Pick' });
const done = new Button({ description: 'Done' });
display(slider);
display(done);

(async () => {
  for await (const value of slider.changes()) {
    console.log(`Now ${value}`);
    if (value >= 10) break;
  }
  await done.clicked();
  console.log(`You picked ${slider.value}`);
})();
```

Breaking out of the loop stops listening, and the loop ends when the widget is closed. Interrupting the kernel stops all the waits: their promises never settle, like the timers it clears.

### Available widgets

- **Numeric**: `IntSlider`, `FloatSlider`, `FloatLogSlider`, `IntRangeSlider`, `FloatRangeSlider`, `Play`, `IntProgress`, `FloatProgress`, `IntText`, `FloatText`, `BoundedIntText`, `BoundedFloatText`
- **Boolean**: `Checkbox`, `ToggleButton`, `Valid`
- **Selection**: `Dropdown`, `RadioButtons`, `Select`, `SelectMultiple`, `ToggleButtons`, `SelectionSlider`, `SelectionRangeSlider`
- **String**: `Text`, `Textarea`, `Password`, `Combobox`
- **Display**: `Label`, `HTML`, `HTMLMath`, `Output`
- **Button**: `Button` (with `.onClick()` handler, called with the button)
- **Color**: `ColorPicker`, `ColorsInput`
- **Date and time**: `DatePicker`, `TimePicker`, `DatetimePicker`, `NaiveDatetimePicker`
- **Tags**: `TagsInput`, `ColorsInput`, `IntsInput`, `FloatsInput`
- **Files**: `FileUpload` (the contents of the files are sent as binary buffers)
- **Media**: `Image`, `Video`, `Audio` (from bytes, sent as binary buffers, a `Blob` or, for `Image`, a drawing, or from a URL with `fromUrl()`)
- **Layout / Style**: `Layout`, `DescriptionStyle`, `SliderStyle`, `ProgressStyle`, `ButtonStyle`, `CheckboxStyle`, `ToggleButtonStyle`, `ToggleButtonsStyle`, `TextStyle`, `HTMLStyle`, `HTMLMathStyle`, `LabelStyle`
- **Containers**: `Box`, `HBox`, `VBox`, `GridBox`, `Accordion`, `Tab`, `Stack`
- **Helpers**: `jslink`, `jsdlink`, `link`, `dlink`, `interact`, `interact_manual`, `interactive`, `interactive_output`, `fixed`

### Ported widget modules

The widget runtime is split into files that roughly follow the upstream `ipywidgets` package structure so it is easier to track what has been ported.

| Upstream `ipywidgets` file                           | Local file                                                                    | Status | Notes                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `packages/base/src/widget.ts`                        | `packages/javascript-kernel-runtime/src/widgets/widget.ts`                    | Ported | Kernel-side `Widget`, with validation and custom messages            |
| `packages/base/src/widget.ts`                        | `packages/javascript-kernel-runtime/src/widgets/widget_dom.ts`                | Ported | `DOMWidget`, with default layout and style instances                 |
| `packages/base/src/widget_layout.ts`                 | `packages/javascript-kernel-runtime/src/widgets/widget_layout.ts`             | Ported | Layout models                                                        |
| `packages/base/src/widget_style.ts`                  | `packages/javascript-kernel-runtime/src/widgets/widget_style.ts`              | Ported | Shared style models, plus control-specific styles gathered here      |
| `packages/controls/src/widget_int.ts`                | `packages/javascript-kernel-runtime/src/widgets/widget_int.ts`                | Ported | Integer widgets, play, progress, and text inputs                     |
| `packages/controls/src/widget_float.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_float.ts`              | Ported | Float widgets                                                        |
| `packages/controls/src/widget_bool.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_bool.ts`               | Ported | Boolean widgets; related styles live in `widget_style.ts`            |
| `packages/controls/src/widget_selection.ts`          | `packages/javascript-kernel-runtime/src/widgets/widget_selection.ts`          | Ported | Values, `[label, value]` pairs and objects of the values by label    |
| `packages/controls/src/widget_string.ts`             | `packages/javascript-kernel-runtime/src/widgets/widget_string.ts`             | Ported | String and display widgets; related styles live in `widget_style.ts` |
| `packages/output/src/output.ts`                      | `packages/javascript-kernel-runtime/src/widgets/widget_output.ts`             | Ported | Output capture, also of async callbacks, and the `append*` methods   |
| `packages/controls/src/widget_button.ts`             | `packages/javascript-kernel-runtime/src/widgets/widget_button.ts`             | Ported | The click handlers get the button                                    |
| `packages/controls/src/widget_color.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_color.ts`              | Ported | Color picker                                                         |
| `packages/controls/src/widget_box.ts`                | `packages/javascript-kernel-runtime/src/widgets/widget_box.ts`                | Ported | Box, HBox, VBox, GridBox                                             |
| `packages/controls/src/widget_selectioncontainer.ts` | `packages/javascript-kernel-runtime/src/widgets/widget_selectioncontainer.ts` | Ported | Accordion, Tab, Stack                                                |
| `packages/controls/src/widget_link.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_link.ts`               | Ported | `jslink`, `jsdlink`, `Link`, `DirectionalLink`, `link` and `dlink`   |
| `ipywidgets/widgets/interaction.py`                  | `packages/javascript-kernel-runtime/src/widgets/widget_interact.ts`           | Ported | `interact`, `interactive`, `interactive_output` and `fixed`          |
| `packages/controls/src/widget_image.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_media.ts`              | Ported | `Image`, with `Video` and `Audio` on the same base, like Python      |
| `packages/controls/src/widget_video.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_media.ts`              | Ported | `Video`                                                              |
| `packages/controls/src/widget_audio.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_media.ts`              | Ported | `Audio`                                                              |
| `packages/controls/src/widget_upload.ts`             | `packages/javascript-kernel-runtime/src/widgets/widget_upload.ts`             | Ported | `FileUpload`, with the contents of the files in binary buffers       |
| `packages/controls/src/widget_date.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_date.ts`               | Ported | `DatePicker`, with `Date` values                                     |
| `packages/controls/src/widget_datetime.ts`           | `packages/javascript-kernel-runtime/src/widgets/widget_date.ts`               | Ported | `DatetimePicker` and `NaiveDatetimePicker`, with `Date` values       |
| `packages/controls/src/widget_time.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_date.ts`               | Ported | `TimePicker`, with string values like `'09:30'`                      |
| `packages/controls/src/widget_tagsinput.ts`          | `packages/javascript-kernel-runtime/src/widgets/widget_tagsinput.ts`          | Ported | `TagsInput`, `ColorsInput`, `IntsInput`, `FloatsInput`               |
| `packages/controls/src/widget_controller.ts`         |                                                                               | Not    | `Controller`: its frontend opens the comms of its buttons and axes   |

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
- `Jupyter.comm.registerTarget(targetName, handler)` calls `handler(comm, data, buffers)` when the frontend opens a comm on the target, and `Jupyter.comm.unregisterTarget(targetName)` removes it. A comm opened on a target without a handler, or whose handler throws, is closed, like in `ipykernel`. The `jupyter.widget.control` target is built in: it sends the state of the widgets to the frontend
- the kernel answers the `comm_info_request` messages with the open comms, so a frontend can find the comms of a running kernel
- a comm has a `commId` and a `targetName`, `send(data, metadata?, buffers?)` and `close(data?)` methods, and the `onMsg` and `onClose` callbacks, called with the data and the binary buffers (`ArrayBuffer`) of the messages of the frontend, objects of the realm of the cells in both kernels, so that `buffers[0] instanceof ArrayBuffer` holds
- once closed, by the kernel or by the frontend, a comm sends nothing: closing it again does nothing, and does not call `onClose` again. So does `close()` on a widget, and `unlink()` on a link: a closed widget does not sync its new values anymore, like in `ipywidgets`
- the outputs of the comm callbacks, and their errors, go to the cell which ran last. The comm messages they send, and the outputs captured by an `Output` widget, go to the message of the frontend which they handle

`context.registerCommTarget()` registers the target of a [startup extension](#kernel-startup-extensions) before the code of the cells runs.

## Execute requests of extensions

Frontend extensions, like a variable inspector, can run code with the options of the [`execute_request`](https://jupyter-client.readthedocs.io/en/latest/messaging.html#execute) message, which the notebook does not use for its cells:

```javascript
const future = kernel.requestExecute({
  code: 'const total = values.reduce((a, b) => a + b, 0)',
  silent: true,
  user_expressions: { total: 'total', count: 'values.length' }
});
const reply = await future.done;
reply.content.user_expressions.total.data['text/plain']; // '6'
```

- `silent: true` runs the code quietly: the kernel sends no `execute_input`, keeps the execution count and the history, and publishes no output, no result and no error for the request. The error is in the reply. Only its comm messages are sent, so the widgets it creates work. The outputs of its timers and callbacks are dropped too, and the outputs of the previous cells, like the ones of their timers, still go to their cells. The code which runs after the reply in a promise the code did not wait for, like `fetch(url).then(r => console.log(r.status))`, and its unhandled rejections, print in the last cell run, like the late outputs of that cell: wait for the promises in silent code
- `store_history: false` keeps the execution count and the history, but the outputs are shown. The tracebacks name the code `<silent-1>`, `<silent-2>`..., instead of the cell of the execution count
- `user_expressions` are evaluated after the code, when it succeeds, like the last expression of a cell: a promise is awaited. The reply holds, for each name, the MIME bundle of the value, as `{ status: 'ok', data, metadata }` with a `text/plain` without colors, or the error, as `{ status: 'error', ename, evalue, traceback }`. Each one must be a single expression: `let x = 1` or `a; b` fail with `SyntaxError: Expected an expression`

JupyterLite cancels the requests waiting to run when a request fails, also when it is silent, and also when it has `stop_on_error: false`, which the kernel can not honour (see [Errors](#errors)).

## Configuration

### Settings

Open **Settings > Settings Editor** and search for **JavaScript Kernel** to change the settings of the kernels. They apply to the kernels started next: the running kernels keep their settings until **Kernel > Restart Kernel**.

| Setting                   | Key                     | Default                     | Effect                                                                                                                                                                                                                      |
| ------------------------- | ----------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Magic imports             | `magicImports`          | `true`                      | Load the packages imported by name from a CDN, see [Imports](#imports). When disabled, only URLs and the specifiers of an import map can be imported.                                                                       |
| CDN base URL              | `magicImportsBaseUrl`   | `https://cdn.jsdelivr.net/` | The base URL of the CDN. A relative URL, like `vendor/`, is resolved against the URL of the JupyterLite site.                                                                                                               |
| Add the npm/ prefix       | `magicImportsNpmPrefix` | `true`                      | Load `lodash-es` from `<CDN base URL>/npm/lodash-es`, like jsDelivr. Disable it for the CDNs serving the packages at their root, like esm.sh.                                                                               |
| Add the +esm suffix       | `magicImportsEsmSuffix` | `true`                      | Add `/+esm` after the package paths which do not end with `.js`, `.mjs`, `.cjs` or `.wasm`, for jsDelivr to serve ES modules, except for the imports with a `type` attribute, like JSON modules. Disable it for other CDNs. |
| Loop timeout (ms)         | `loopTimeout`           | `10000`                     | The time a loop can keep the page busy in `JavaScript (IFrame)` before it is stopped, see [loop protection](#interrupting-code-and-loop-protection). 0 turns it off.                                                        |
| Output limit (characters) | `maxStreamOutput`       | `5000000`                   | The number of characters a cell can print with the `console` methods, see [Console](#console). 0 for no limit.                                                                                                              |

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

You can disable either one using `disabledExtensions` in the `jupyter-config-data` of the `jupyter-lite.json` file, in the folder where `jupyter lite build` runs. The build merges it into the `jupyter-lite.json` of the site.

Disable worker mode:

```json
{
  "jupyter-lite-schema-version": 0,
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
  "jupyter-lite-schema-version": 0,
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
- `@jupyterlite/javascript-kernel`: the JupyterLite kernel, with the iframe and Web Worker runtimes. It also exports everything from `@jupyterlite/javascript-kernel-runtime`. The iframe backend calls the runtime API directly in the page, and the Web Worker backend over Comlink. `IFrameRuntimeBackend` keeps its iframe rendered but invisible, in a container fixed on the page, of `IFrameRuntimeBackend.FRAME_WIDTH` × `FRAME_HEIGHT` pixels, with `visibility: hidden`, `inert` and `aria-hidden`, which `onReady` gets as `container`, and it gives the focus back to the page when the iframe takes it. When the code of a cell reloads the iframe, `IFrameRuntimeBackend` calls its `onRestart` option and starts a new iframe, for which it calls `executorFactory` and `onReady` again: the `onRuntimeReady` method of the kernels building on `JavaScriptKernel`, like the p5.js kernel, runs again with the new global scope and executor. `JavaScriptKernel` handles the silent `execute_request` messages itself, without `execute_input`, but still calls `executeRequest()`, which these kernels override: for a silent request, `content.silent` is true and `parentHeader` is still the header of the cell which ran before it, so an override checks `content.silent` before publishing outputs. JupyterLite only cancels the queued cells on interrupt: `installKernelInterrupts(client)` makes its kernel client also call the `interrupt()` method of the kernels, like `JavaScriptKernel.interrupt()`. The extension calls it, and the extensions of kernels building on `JavaScriptKernel`, like the p5.js kernel, can call it too, since installing it twice does nothing. The `executorOptions`, `loopTimeout` and `maxStreamOutput` options of `JavaScriptKernel` configure the runtime when it starts: the extension sets them from the [settings](#settings), and the kernels building on `JavaScriptKernel` keep the defaults unless they pass them. Its `cdnSetting` option, like `Settings > Settings Editor > JavaScript Kernel`, names where the users set the CDN, in the [hint](#hints) of the imports which fail: the extension sets it, and without it the hint does not point to a setting. `IFrameRuntimeBackend.findLiveNode(id)` finds the [live DOM elements](#live-dom-elements) of the iframe runtimes of the page, from the id of their `application/vnd.jupyterlite.javascript-node+json` outputs, so the kernels building on `JavaScriptKernel` with the iframe runtime show their elements live too.
- `@jupyterlite/javascript-kernel-extension`: the JupyterLite extension registering the kernels, with their settings, and the renderer of the live DOM elements.

### Development install

You will need Node.js to build the extension package, and a Python environment, like a virtual environment.

The `jlpm` command is JupyterLab's pinned version of
[yarn](https://yarnpkg.com/) that is installed with JupyterLab. You may use
`yarn` or `npm` in lieu of `jlpm` below.

```bash
# Clone the repo to your local environment
# Change directory to the javascript-kernel directory
# Install the package in development mode, with JupyterLab and jupyterlite-core
pip install -e ".[dev]"
# Link your development version of the extension in the Python environment
jupyter-builder develop . --overwrite
# Rebuild the packages and the extension after making changes
jlpm build
```

The kernels run in JupyterLite, not in JupyterLab: build a JupyterLite site with the extension, with the example notebooks, and serve it on http://localhost:8000:

```bash
jupyter lite build --contents examples
jupyter lite serve
```

You can watch the source directory to rebuild the extension automatically on every saved change:

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
jlpm watch
# Build and serve the JupyterLite site in another terminal
jupyter lite serve --contents examples
```

`jupyter lite serve` builds the site first. The site has a copy of the extension: after a change, stop `jupyter lite serve` and run it again, or run `jupyter lite build --contents examples` in another terminal, then refresh the page (you may need to wait several seconds for the extension to be rebuilt).

By default, the `jlpm build` command builds the extension in development mode, with source maps, to make it easier to debug using the browser dev tools. `jlpm build:prod` builds it like a release.

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
folder is located. Then you can remove the symlink named `@jupyterlite/javascript-kernel-extension` within that folder.

### Packaging the extension

See [RELEASE](RELEASE.md) to publish the Python package and the npm packages, and the [CHANGELOG](CHANGELOG.md) for the migration notes of each release.

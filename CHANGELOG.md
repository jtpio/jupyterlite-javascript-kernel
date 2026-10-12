# Changelog

## Migrating to 0.4.0

These notes cover the upgrade from 0.3.0, the last stable release. The first
part lists the breaking changes of the 0.4.0 alphas, the second part the
breaking changes since 0.4.0a5, which also apply when upgrading from 0.3.0.
The release entries below list every change.

### From 0.3.0

#### For the deployments

- The kernel requires JupyterLite 0.8, instead of JupyterLite 0.2 or 0.3.
- The extension registers two kernels instead of one (see
  [Runtime modes](README.md#runtime-modes)). The kernel named `javascript`,
  which ran the code in a Web Worker, is now `JavaScript (IFrame)`: it runs
  the code in a hidden iframe on the thread of the page, with access to the
  DOM. The Web Worker kernel is now named `javascript-worker`, and shown as
  `JavaScript (Web Worker)`. A deployment can disable either kernel (see
  [Enable or disable specific modes](README.md#enable-or-disable-specific-modes)).

#### For the notebooks

- The notebooks saved with the kernelspec `javascript` now run in
  `JavaScript (IFrame)`, on the thread of the page: a synchronous loop
  freezes JupyterLite until it is stopped after 10 s with a `LoopTimeoutError`
  (see
  [Interrupting code and loop protection](README.md#interrupting-code-and-loop-protection)).
  The notebooks which need the Web Worker, for long computations or for
  isolation from the page, switch to `JavaScript (Web Worker)` with
  **Kernel > Change Kernel...**, which saves the kernelspec
  `javascript-worker`.

#### For the extensions and the kernels building on the JavaScript kernel

- The packages depend on `@jupyterlite/services` 0.8, which replaces
  `@jupyterlite/kernel` and `@jupyterlite/server`: `BaseKernel`, `IKernel`
  and `IKernelSpecs` are imported from `@jupyterlite/services`, and the
  plugins are `JupyterFrontEndPlugin`s instead of `JupyterLiteServerPlugin`s.
- `JavaScriptKernel` runs the code in the runtime given by the new `runtime`
  option, `'iframe'` by default, or `'worker'`. Its Web Worker members,
  `initWorker()`, `initRemote()` and `remoteKernel`, are removed: override
  `createBackend()` or `onRuntimeReady()` instead.
- The `IJavaScriptWorkerKernel` and `IRemoteJavaScriptWorkerKernel`
  interfaces of `lib/tokens`, and the `JavaScriptRemoteKernel` class of
  `lib/worker`, are removed.

### Since 0.4.0a5

#### For the deployments

- The Python package requires JupyterLite 0.8: it depends on
  `jupyterlite-core>=0.8,<0.9`, and installing it in an environment with an
  older `jupyterlite-core` upgrades it.
- The extension is installed in the `labextensions` folder under its npm name,
  `@jupyterlite/javascript-kernel-extension`. Remove a symlink named
  `@jupyterlite/javascript-kernel` left by an earlier development install.
- The kernels have [settings](README.md#settings), which a deployment can set
  in its `overrides.json`. The `JavaScript (IFrame)` kernel stops the loops
  keeping the page busy for more than 10 s, and the cells print at most
  5,000,000 characters: raise or turn off these limits with the **Loop timeout
  (ms)** and **Output limit (characters)** settings.

#### For the notebooks

- The second argument of `display()` is an object of options:
  `display(value, metadata)` becomes `display(value, { metadata })`.
- The cells run like in a REPL (see [Cells](README.md#cells)): the
  declarations are globals shared with the next cells, `const` can be declared
  again, and `_` and `_error` hold the last result and the last error.
- `require()` throws a `ReferenceError` suggesting `import`.
- The errors thrown later, in timers, event listeners and widget callbacks,
  are printed in the notebook as `Uncaught ...` instead of the console of the
  browser.
- The `language_info.version` saved in the notebook metadata is the
  ECMAScript edition parsed by the kernel, like `ES2026`, instead of `es2017`.
- An interrupt can restart the Web Worker of `JavaScript (Web Worker)`, when
  the cell does not stop, and reloading the page of the iframe restarts the
  iframe of `JavaScript (IFrame)`: the variables of the previous cells are
  then lost.

#### For the extensions and the kernels building on the JavaScript kernel

- The runtime running next to the code of the cells (the executor, the
  evaluator, `display()`, the console, comms and widgets) moved to the new
  `@jupyterlite/javascript-kernel-runtime` package, which does not depend on
  JupyterLite. `@jupyterlite/javascript-kernel` still exports everything from
  it, so the imports from `@jupyterlite/javascript-kernel` keep working, but
  the deep imports, like `@jupyterlite/javascript-kernel/lib/executor`, must
  use `@jupyterlite/javascript-kernel-runtime` (or, better, its main entry).
- `DisplayHelper`, `IDisplayData` and `IDisplayCallbacks` are replaced by
  `createDisplay()`, `IDisplay`, `IDisplayHost` and `DisplayHandle`.
- The iframe runtime is called directly from the page instead of over
  `postMessage()`: other windows can not run code in the kernel by posting
  messages to the iframe anymore.
- `onRuntimeReady()` can run more than once for a kernel: again with a new
  global scope and executor when a cell reloads the iframe.
- `JavaScriptKernel` handles the silent `execute_request` messages itself, but
  still calls `executeRequest()`: an override checks `content.silent` before
  publishing outputs.
- The runtime output messages carry the `parentHeader` of the message of the
  frontend they belong to, and `JavaScriptKernel` publishes them with it.
- JupyterLite only cancels the queued cells on interrupt:
  `installKernelInterrupts(client)` makes its kernel client also call the
  `interrupt()` method of the kernels. The extension calls it, and the
  extensions of the kernels building on `JavaScriptKernel` can call it too.

See the [README](README.md) and the
[README of the runtime package](packages/javascript-kernel-runtime/README.md)
for the details.

<!-- <START NEW CHANGELOG ENTRY> -->

## 0.4.0a5

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/@jupyterlite/javascript-kernel-extension@0.4.0-alpha.4...79f81cdbbd71c41d402a764e06d528836477add3))

### Enhancements made

- Support startup extensions for JavaScript kernels [#29](https://github.com/jupyterlite/javascript-kernel/pull/29) ([@MUFFANUJ](https://github.com/MUFFANUJ), [@jtpio](https://github.com/jtpio), [@krassowski](https://github.com/krassowski))

### Maintenance and upkeep improvements

- Install jupyterlab-widgets for the GitHub Pages deployment [#27](https://github.com/jupyterlite/javascript-kernel/pull/27) ([@jtpio](https://github.com/jtpio), [@bollwyvl](https://github.com/bollwyvl))
- Update dependencies [#26](https://github.com/jupyterlite/javascript-kernel/pull/26) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

The following people contributed discussions, new ideas, code and documentation contributions, and review.
See [our definition of contributors](https://github-activity.readthedocs.io/en/latest/use/#how-does-this-tool-define-contributions-in-the-reports).

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2026-05-12&to=2026-07-14&type=c))

@bollwyvl ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Abollwyvl+updated%3A2026-05-12..2026-07-14&type=Issues)) | @jtpio ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2026-05-12..2026-07-14&type=Issues)) | @krassowski ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Akrassowski+updated%3A2026-05-12..2026-07-14&type=Issues)) | @MUFFANUJ ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3AMUFFANUJ+updated%3A2026-05-12..2026-07-14&type=Issues))

<!-- <END NEW CHANGELOG ENTRY> -->

## 0.4.0a4

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/@jupyterlite/javascript-kernel-extension@0.4.0-alpha.3...70fde687bf34470c7cf3dcf5f154dc6b176fe6b4))

### Enhancements made

- Jupyter Widgets [#24](https://github.com/jupyterlite/javascript-kernel/pull/24) ([@jtpio](https://github.com/jtpio), [@bollwyvl](https://github.com/bollwyvl))

### Contributors to this release

The following people contributed discussions, new ideas, code and documentation contributions, and review.
See [our definition of contributors](https://github-activity.readthedocs.io/en/latest/use/#how-does-this-tool-define-contributions-in-the-reports).

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2026-03-09&to=2026-05-12&type=c))

@bollwyvl ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Abollwyvl+updated%3A2026-03-09..2026-05-12&type=Issues)) | @jtpio ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2026-03-09..2026-05-12&type=Issues))

## 0.4.0a3

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/@jupyterlite/javascript-kernel-extension@0.4.0-alpha.2...8c03818141798cf3c3424671187d68887513cda8))

### Enhancements made

- Improve error handling [#23](https://github.com/jupyterlite/javascript-kernel/pull/23) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

The following people contributed discussions, new ideas, code and documentation contributions, and review.
See [our definition of contributors](https://github-activity.readthedocs.io/en/latest/use/#how-does-this-tool-define-contributions-in-the-reports).

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2026-03-06&to=2026-03-09&type=c))

@jtpio ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2026-03-06..2026-03-09&type=Issues))

## 0.4.0a2

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/@jupyterlite/javascript-kernel-extension@0.4.0-alpha.1...7d34a537dff88d716c2a30ad7a808f2f530eaf2e))

### Enhancements made

- Add predefined docs if available [#22](https://github.com/jupyterlite/javascript-kernel/pull/22) ([@jtpio](https://github.com/jtpio))

### Maintenance and upkeep improvements

- Fix shared data [#21](https://github.com/jupyterlite/javascript-kernel/pull/21) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

The following people contributed discussions, new ideas, code and documentation contributions, and review.
See [our definition of contributors](https://github-activity.readthedocs.io/en/latest/use/#how-does-this-tool-define-contributions-in-the-reports).

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2026-03-05&to=2026-03-06&type=c))

@jtpio ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2026-03-05..2026-03-06&type=Issues))

## 0.4.0a1

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/@jupyterlite/javascript-kernel-extension@0.4.0-alpha.0...87c8a2403f008083cf3086dbde5c06946a5b184d))

### Enhancements made

- Many improvements [#20](https://github.com/jupyterlite/javascript-kernel/pull/20) ([@jtpio](https://github.com/jtpio), [@bollwyvl](https://github.com/bollwyvl))

### Maintenance and upkeep improvements

- Update to JupyterLite 0.7.0 [#18](https://github.com/jupyterlite/javascript-kernel/pull/18) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

The following people contributed discussions, new ideas, code and documentation contributions, and review.
See [our definition of contributors](https://github-activity.readthedocs.io/en/latest/use/#how-does-this-tool-define-contributions-in-the-reports).

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2024-05-23&to=2026-03-05&type=c))

@bollwyvl ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Abollwyvl+updated%3A2024-05-23..2026-03-05&type=Issues)) | @jtpio ([activity](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2024-05-23..2026-03-05&type=Issues))

## 0.4.0a0

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/@jupyterlite/javascript-kernel-extension@0.3.0...d557adf3cd01c6007b64e5a9be185d091c6531c3))

### Maintenance and upkeep improvements

- Update to JupyterLite 0.4.0 [#14](https://github.com/jupyterlite/javascript-kernel/pull/14) ([@jtpio](https://github.com/jtpio))
- Fix CI [#13](https://github.com/jupyterlite/javascript-kernel/pull/13) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2024-03-26&to=2024-05-23&type=c))

[@jtpio](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2024-03-26..2024-05-23&type=Issues)

## 0.3.0

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/@jupyterlite/javascript-kernel-extension@0.3.0-alpha.1...0ec2e58c1ec85fefbb35109e8414f5a2ba97de80))

### Maintenance and upkeep improvements

- Update releaser workflows [#11](https://github.com/jupyterlite/javascript-kernel/pull/11) ([@jtpio](https://github.com/jtpio))
- Update `@jupyterlite` packages [#10](https://github.com/jupyterlite/javascript-kernel/pull/10) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2024-02-16&to=2024-03-26&type=c))

[@jtpio](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2024-02-16..2024-03-26&type=Issues)

## 0.3.0a1

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/v0.3.0a0...24e8d7abb6bd51633233c5bbeac9d54a70e98047))

### Maintenance and upkeep improvements

- Fix shared packages [#8](https://github.com/jupyterlite/javascript-kernel/pull/8) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2024-02-15&to=2024-02-16&type=c))

[@jtpio](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2024-02-15..2024-02-16&type=Issues)

## 0.3.0a0

([Full Changelog](https://github.com/jupyterlite/javascript-kernel/compare/123a40c18f04b8aa22a86f2352366153e8ed1706...535e97b683a0fa127a936fbe07e05345794a3674))

### Maintenance and upkeep improvements

- Update pre-release replace logic [#7](https://github.com/jupyterlite/javascript-kernel/pull/7) ([@jtpio](https://github.com/jtpio))
- Better handle pre-releases [#6](https://github.com/jupyterlite/javascript-kernel/pull/6) ([@jtpio](https://github.com/jtpio))
- Add step to deploy to GitHub Pages [#4](https://github.com/jupyterlite/javascript-kernel/pull/4) ([@jtpio](https://github.com/jtpio))
- Updates and fixes [#1](https://github.com/jupyterlite/javascript-kernel/pull/1) ([@jtpio](https://github.com/jtpio))

### Documentation improvements

- README updates [#5](https://github.com/jupyterlite/javascript-kernel/pull/5) ([@jtpio](https://github.com/jtpio))

### Contributors to this release

([GitHub contributors page for this release](https://github.com/jupyterlite/javascript-kernel/graphs/contributors?from=2024-02-15&to=2024-02-15&type=c))

[@jtpio](https://github.com/search?q=repo%3Ajupyterlite%2Fjavascript-kernel+involves%3Ajtpio+updated%3A2024-02-15..2024-02-15&type=Issues)

For previous versions, you can refer to the JupyterLite changelog, which is where this kernel used to be developed: https://jupyterlite.readthedocs.io/en/stable/changelog.html

# @jupyterlite/javascript-kernel

The JavaScript kernel of [JupyterLite](https://jupyterlite.readthedocs.io), with
two runtimes: a hidden `iframe` on the page (`JavaScript (IFrame)`) and a Web
Worker (`JavaScript (Web Worker)`).

It exports `JavaScriptKernel`, the runtime backends, the registry of the
startup extensions and `installKernelInterrupts()`, for the extensions of
kernels building on it, like the
[p5.js kernel](https://github.com/jupyterlite/p5-kernel). It also exports
everything from
[`@jupyterlite/javascript-kernel-runtime`](https://github.com/jupyterlite/javascript-kernel/tree/main/packages/javascript-kernel-runtime),
the engine-neutral runtime running next to the code of the cells.

To use the kernels in a JupyterLite site, install the
[`jupyterlite-javascript-kernel`](https://pypi.org/project/jupyterlite-javascript-kernel/)
Python package. See the
[README of the repository](https://github.com/jupyterlite/javascript-kernel#readme)
for the features and the API.

# UI tests

The UI tests open a JupyterLite site in a browser, and use the JavaScript kernels like a user would: from the launcher, the menus, the notebooks, the consoles and the widgets. They are written with [Playwright](https://playwright.dev) and the [Galata](https://github.com/jupyterlab/jupyterlab/tree/main/galata) helpers.

## Run the tests

Install the extension and the dependencies of the JupyterLite site first, from the root of the repository:

```bash
pip install . jupyterlite-core jupyterlab-widgets jupyter-server
```

Then build the site in `dist` with the example notebooks, and run the tests:

```bash
cd ui-tests
jlpm install
jlpm build
jlpm playwright install chromium
jlpm test
```

`jlpm test` serves the site on http://localhost:8000. Some tests load packages from [jsDelivr](https://www.jsdelivr.com), so they need a network connection.

# Making a new release of jupyterlite_javascript_kernel

A release publishes four packages with the same version:

- the `jupyterlite-javascript-kernel` Python package on PyPI, which installs
  the prebuilt extension in a JupyterLite site
- the `@jupyterlite/javascript-kernel-runtime`, `@jupyterlite/javascript-kernel`
  and `@jupyterlite/javascript-kernel-extension` npm packages, for the kernels
  and extensions building on them

They can be published with the [Jupyter Releaser](https://github.com/jupyter-server/jupyter_releaser)
(recommended) or manually.

## Automated releases with the Jupyter Releaser

Check out the [workflow documentation](https://jupyter-releaser.readthedocs.io/en/latest/get_started/making_release_from_repo.html) for more information.

### Set up the repository

Once, in the settings of the GitHub repository:

- Create an [environment](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)
  named `release`. The "Step 2: Publish Release" workflow (`publish-release.yml`)
  runs in it, with `environment: release`, so the secrets below can be limited
  to it, and it can require a review before publishing.
- Add the `APP_ID` variable and the `APP_PRIVATE_KEY` secret of the GitHub App
  which pushes the release commit and tag, and publishes the GitHub release.
- Add the `NPM_TOKEN` secret: an npm
  [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
  with the **Read and write** permission on the packages and scopes of the
  `@jupyterlite` organization, and **Bypass two-factor authentication** enabled.
  A token limited to a list of existing packages can not publish a new one, like
  `@jupyterlite/javascript-kernel-runtime` on its first release. npm granular
  tokens with write access expire (after 90 days at most): renew the secret
  before a release when it has expired. The legacy "Automation" tokens are
  retired.
- Set up the PyPI project with a
  [trusted publisher](https://docs.pypi.org/trusted-publishers/adding-a-publisher/):
  the _workflow name_ is `publish-release.yml` and the _environment name_ is
  `release`, the environment of the job. The job has the `id-token: write`
  permission which trusted publishing needs, so no PyPI token is needed.

### Cut a release

- Go to the Actions panel
- Run the "Step 1: Prep Release" workflow, with the new version, like `0.4.0`
  or `0.4.0-beta.0`. It bumps the versions with `scripts/bump-version.py`, which
  also regenerates the version reported by the kernel, and drafts the changelog
- Check the draft changelog and the draft GitHub release: add the migration
  notes of the breaking changes, see the top of [CHANGELOG.md](CHANGELOG.md)
- Run the "Step 2: Publish Release" workflow with the URL of the draft release

## Manual release

### Version

Bump the versions of the npm packages and of the Python package together:

```bash
python scripts/bump-version.py <new-version>
```

It runs `lerna version` on the npm packages, regenerates
`packages/javascript-kernel/src/version.ts` (the version reported by the
kernel, which `jlpm lint:check` verifies) and sets the version of the root
`package.json`, which is the version of the Python package. `hatch version`
alone only changes the root `package.json`.

### Python package

Clean up the development files, then build the source package (`.tar.gz`)
and the wheel (`.whl`) in the `dist/` directory:

```bash
pip install build twine
jlpm clean:all
python -m build
```

> `python setup.py sdist bdist_wheel` is deprecated and will not work for this package.

Then upload them to PyPI:

```bash
twine upload dist/*
```

### npm packages

Build the packages, then publish with Lerna the ones whose version is not on
npm yet, in the order of their dependencies:

```bash
jlpm
jlpm build:prod
npm login
jlpm lerna publish from-package
```

`jlpm run publish` does the same after cleaning the packages.

Check the contents of a package before publishing it with
`npm pack --dry-run` in its folder: the extension needs its `lib/`, `schema/`
and `style/icons/` folders, and each package has its `README.md` and `LICENSE`.

## Publishing to `conda-forge`

If the package is not on conda forge yet, check the documentation to learn how to add it: https://conda-forge.org/docs/maintainer/adding_pkgs.html

Otherwise a bot should pick up the new version publish to PyPI, and open a new PR on the feedstock repository automatically.

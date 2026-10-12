// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Build the single-file bundles of the runtime from lib/, with acorn,
 * acorn-walk and astring included, for the kernels that do not use npm:
 *
 *   dist/javascript-kernel-runtime.umd.js      UMD (CommonJS, AMD or global)
 *   dist/javascript-kernel-runtime.umd.min.js  the same, minified
 *   dist/javascript-kernel-runtime.mjs         ES module
 *
 * Usage (after tsc): node scripts/bundle.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BannerPlugin, rspack } from '@rspack/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(join(root, 'package.json'));
const { name, version, license } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf-8')
);

/**
 * The directory and license of a bundled dependency.
 */
function dependency(dependencyName) {
  let directory = dirname(require.resolve(dependencyName));
  while (
    !statSync(join(directory, 'package.json'), { throwIfNoEntry: false })
  ) {
    directory = dirname(directory);
  }
  const { version } = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf-8')
  );
  const text = readFileSync(join(directory, 'LICENSE'), 'utf-8');
  return { name: dependencyName, version, text };
}

const dependencies = [
  dependency('acorn'),
  dependency('acorn-walk'),
  dependency('astring')
];

const banner =
  `${name} ${version} | ${license}\n` +
  `Includes ${dependencies
    .map(dependency => `${dependency.name} ${dependency.version} (MIT)`)
    .join(', ')}, see THIRD_PARTY_LICENSES.txt`;

/**
 * The rspack configuration of one of the bundles.
 */
function config({ filename, library, minimize, module = false }) {
  return {
    mode: 'production',
    context: root,
    entry: './lib/index.js',
    // Plain ECMAScript: no web or Node.js runtime code
    target: ['es2020'],
    node: false,
    devtool: 'source-map',
    resolve: {
      // The ES modules of the dependencies, not the browser build of astring
      mainFields: ['module', 'main'],
      conditionNames: ['import', 'module', 'default']
    },
    optimization: {
      minimize,
      splitChunks: false,
      runtimeChunk: false,
      concatenateModules: true
    },
    output: {
      path: dist,
      filename,
      library,
      module,
      globalObject: 'globalThis',
      publicPath: '',
      chunkFormat: false,
      chunkLoading: false,
      asyncChunks: false,
      wasmLoading: false
    },
    experiments: module ? { outputModule: true } : {},
    plugins: [new BannerPlugin({ banner })],
    performance: { hints: false }
  };
}

const umd = { type: 'umd', name: 'JupyterJavaScriptRuntime' };

const configs = [
  config({
    filename: 'javascript-kernel-runtime.umd.js',
    library: umd,
    minimize: false
  }),
  config({
    filename: 'javascript-kernel-runtime.umd.min.js',
    library: umd,
    minimize: true
  }),
  config({
    filename: 'javascript-kernel-runtime.mjs',
    library: { type: 'modern-module' },
    minimize: false,
    module: true
  })
];

rmSync(dist, { recursive: true, force: true });

const stats = await new Promise((resolvePromise, reject) => {
  rspack(configs, (error, stats) => {
    if (error) {
      reject(error);
    } else {
      resolvePromise(stats);
    }
  });
});

if (stats.hasErrors() || stats.hasWarnings()) {
  console.error(stats.toString({ all: false, errors: true, warnings: true }));
  if (stats.hasErrors()) {
    process.exit(1);
  }
}

writeFileSync(
  join(dist, 'THIRD_PARTY_LICENSES.txt'),
  dependencies
    .map(
      dependency =>
        `${dependency.name} ${dependency.version}\n\n${dependency.text.trim()}\n`
    )
    .join('\n' + '-'.repeat(72) + '\n\n')
);

// The runtime only imports types from JupyterLab: the bundles must not
// include any of its code
for (const { output } of configs) {
  const file = join(dist, output.filename);
  const code = readFileSync(file, 'utf-8');
  if (code.includes('@jupyterlab/')) {
    console.error(`${file} includes code of @jupyterlab packages`);
    process.exit(1);
  }
  const size = (statSync(file).size / 1024).toFixed(0);
  console.log(`dist/${output.filename}: ${size} KB`);
}

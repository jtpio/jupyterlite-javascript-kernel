# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

"""Build the JupyterLite site used by the UI tests, with the Galata extension."""

from pathlib import Path
from subprocess import run

import jupyterlab

extra_labextensions_path = str(Path(jupyterlab.__file__).parent / "galata")
cmd = f"jupyter lite build --FederatedExtensionAddon.extra_labextensions_path={extra_labextensions_path}"

run(cmd, check=True, shell=True)

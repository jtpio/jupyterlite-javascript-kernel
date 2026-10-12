// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { PageConfig } from '@jupyterlab/coreutils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { IServiceWorkerManager } from '@jupyterlite/apputils';
import type { IKernel } from '@jupyterlite/services';

import { IKernelClient, IKernelSpecs } from '@jupyterlite/services';
import { Token } from '@lumino/coreutils';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { DisposableDelegate } from '@lumino/disposable';
import type { IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';

import {
  IJavaScriptKernelStartupRegistry,
  JavaScriptKernel,
  installKernelInterrupts
} from '@jupyterlite/javascript-kernel';
import type { RuntimeMode } from '@jupyterlite/javascript-kernel';

import jsLogo32 from '../style/icons/logo-32x32.png';

import jsLogo64 from '../style/icons/logo-64x64.png';

/**
 * The id of the plugin of the settings of the kernels.
 */
const KERNEL_SETTINGS_ID =
  '@jupyterlite/javascript-kernel-extension:kernel-settings';

/**
 * The settings of the JavaScript kernels.
 */
interface IKernelSettings {
  /**
   * The options of a kernel from the current settings, read when the kernel
   * starts.
   */
  kernelOptions(
    runtime: RuntimeMode
  ): Promise<Partial<JavaScriptKernel.IOptions>>;
}

/**
 * The token of the settings of the JavaScript kernels, private to the
 * extension.
 */
const IKernelSettings = new Token<IKernelSettings>(
  '@jupyterlite/javascript-kernel-extension:IKernelSettings',
  'The settings of the JavaScript kernels.'
);

/**
 * Register a JavaScript kernelspec for a given runtime.
 */
interface IRegisterKernelOptions {
  name: string;
  displayName: string;
  runtime: RuntimeMode;
  browsingContextId?: string;

  /**
   * The settings of the kernels. Without them, the kernels use the defaults
   * of the runtime.
   */
  settings?: IKernelSettings | null;
}

const registerKernel = (
  kernelspecs: IKernelSpecs,
  options: IRegisterKernelOptions
) => {
  const { name, displayName, runtime, browsingContextId, settings } = options;

  kernelspecs.register({
    spec: {
      name,
      display_name: displayName,
      language: 'javascript',
      argv: [],
      spec: {
        argv: [],
        env: {},
        display_name: displayName,
        language: 'javascript',
        interrupt_mode: 'message',
        metadata: {
          runtime
        }
      },
      resources: {
        'logo-32x32': jsLogo32,
        'logo-64x64': jsLogo64
      }
    },
    create: async (options: IKernel.IOptions): Promise<IKernel> => {
      // Read when the kernel starts, also on restart: the running kernels
      // keep their options
      const settingsOptions = (await settings?.kernelOptions(runtime)) ?? {};
      const kernel = new JavaScriptKernel({
        ...options,
        ...settingsOptions,
        runtime,
        browsingContextId,
        startupExtensions: Private.startupExtensions
      } as JavaScriptKernel.IOptions);
      Private.kernelCreated.emit(kernel);
      return kernel;
    }
  });
};

/**
 * In-memory registry for JavaScript kernel startup extensions.
 */
class JavaScriptKernelStartupRegistry implements IJavaScriptKernelStartupRegistry {
  get startupExtensions(): readonly JavaScriptKernel.IStartupExtension[] {
    return [...Private.startupExtensions];
  }

  registerStartupExtension(
    extension: JavaScriptKernel.IStartupExtension
  ): IDisposable {
    const existing = Private.startupExtensions.findIndex(
      item => item.id === extension.id
    );

    if (existing !== -1) {
      throw new Error(
        `JavaScript kernel startup extension "${extension.id}" is already registered`
      );
    }

    Private.startupExtensions.push(extension);
    void Promise.all(
      [...Private.kernels].map(kernel =>
        kernel.applyStartupExtension(extension)
      )
    ).catch(error => {
      console.error(
        `[javascript-kernel] Failed to apply startup extension "${extension.id}".`,
        error
      );
    });

    return new DisposableDelegate(() => {
      const index = Private.startupExtensions.indexOf(extension);
      if (index !== -1) {
        Private.startupExtensions.splice(index, 1);
        void Promise.all(
          [...Private.kernels].map(kernel =>
            kernel.removeStartupExtension(extension)
          )
        ).catch(error => {
          console.error(
            `[javascript-kernel] Failed to remove startup extension "${extension.id}".`,
            error
          );
        });
      }
    });
  }
}

namespace Private {
  /**
   * The options of a kernel from the settings of the kernels. The values of
   * the wrong type, which the settings registry should not let through, are
   * left out, so the kernel uses its defaults.
   */
  export function toKernelOptions(
    composite: ReadonlyPartialJSONObject,
    runtime: RuntimeMode
  ): Partial<JavaScriptKernel.IOptions> {
    const flag = (key: string): boolean | undefined => {
      const value = composite[key];
      return typeof value === 'boolean' ? value : undefined;
    };
    const count = (key: string): number | undefined => {
      const value = composite[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    };
    return {
      executorOptions: {
        magicImports: {
          enabled: flag('magicImports'),
          baseUrl: resolveCdnUrl(composite.magicImportsBaseUrl),
          enableAutoNpm: flag('magicImportsNpmPrefix'),
          appendEsmSuffix: flag('magicImportsEsmSuffix')
        }
      },
      maxStreamOutput: count('maxStreamOutput'),
      // The Web Worker runs off the page thread: its loops are interrupted,
      // or it is restarted
      loopTimeout: runtime === 'iframe' ? count('loopTimeout') : undefined
    };
  }

  /**
   * Resolve the CDN base URL of the settings against the URL of the site.
   *
   * A relative URL is made absolute here, in the page: the dynamic imports
   * would resolve it against the page in the iframe, and against the script
   * of the Web Worker.
   */
  export function resolveCdnUrl(value: unknown): string | undefined {
    const url = typeof value === 'string' ? value.trim() : '';
    if (!url) {
      return undefined;
    }
    try {
      return new URL(url, new URL(PageConfig.getBaseUrl(), location.href)).href;
    } catch {
      return undefined;
    }
  }

  export const startupExtensions: JavaScriptKernel.IStartupExtension[] = [];
  export const kernels = new Set<JavaScriptKernel>();

  const kernelCreatedOwner = {};
  export const kernelCreated = new Signal<
    typeof kernelCreatedOwner,
    JavaScriptKernel
  >(kernelCreatedOwner);

  /**
   * Track an active JavaScript kernel for late startup registrations.
   */
  const trackKernel = (kernel: JavaScriptKernel): void => {
    kernels.add(kernel);
    void Promise.all(
      startupExtensions.map(extension =>
        kernel.applyStartupExtension(extension)
      )
    ).catch(error => {
      console.error(
        '[javascript-kernel] Failed to apply startup extensions.',
        error
      );
    });
    const untrackKernel = (sender: JavaScriptKernel): void => {
      kernels.delete(sender);
      sender.disposed.disconnect(untrackKernel);
    };
    kernel.disposed.connect(untrackKernel);
  };

  kernelCreated.connect((_sender, kernel) => {
    trackKernel(kernel);
  });
}

/**
 * Plugin providing the JavaScript kernel startup extension registry.
 */
const startupExtensionsRegistry: JupyterFrontEndPlugin<IJavaScriptKernelStartupRegistry> =
  {
    id: '@jupyterlite/javascript-kernel-extension:startup-extensions',
    autoStart: true,
    provides: IJavaScriptKernelStartupRegistry,
    activate: () => new JavaScriptKernelStartupRegistry()
  };

/**
 * Plugin providing the settings of the JavaScript kernels, edited in the
 * Settings Editor, with the defaults of the deployment from overrides.json.
 */
const kernelSettings: JupyterFrontEndPlugin<IKernelSettings> = {
  id: KERNEL_SETTINGS_ID,
  description: 'Provides the settings of the JavaScript kernels.',
  autoStart: true,
  provides: IKernelSettings,
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    registry: ISettingRegistry | null
  ): IKernelSettings => {
    // Not awaited, so the kernels are registered at once: only the kernels
    // starting wait for the settings
    const loaded = registry
      ? registry.load(KERNEL_SETTINGS_ID).catch(error => {
          console.warn(
            '[javascript-kernel] Failed to load the settings, using the defaults.',
            error
          );
          return null;
        })
      : Promise.resolve(null);
    return {
      kernelOptions: async runtime => {
        const settings = await loaded;
        // The composite has the last saved values
        return settings
          ? Private.toKernelOptions(settings.composite, runtime)
          : {};
      }
    };
  }
};

/**
 * Plugin registering the iframe JavaScript kernel.
 */
const kernelIFrame: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:kernel-iframe',
  autoStart: true,
  requires: [IKernelSpecs],
  optional: [IKernelSettings],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    settings: IKernelSettings | null
  ) => {
    registerKernel(kernelspecs, {
      name: 'javascript',
      displayName: 'JavaScript (IFrame)',
      runtime: 'iframe',
      settings
    });
  }
};

/**
 * Plugin registering the worker JavaScript kernel.
 */
const kernelWorker: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:kernel-worker',
  autoStart: true,
  requires: [IKernelSpecs],
  optional: [IServiceWorkerManager, IKernelSettings],
  activate: (
    app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    serviceWorkerManager: IServiceWorkerManager | null,
    settings: IKernelSettings | null
  ) => {
    registerKernel(kernelspecs, {
      name: 'javascript-worker',
      displayName: 'JavaScript (Web Worker)',
      runtime: 'worker',
      settings,
      // The service worker relays the requests for user input of prompt()
      browsingContextId: serviceWorkerManager?.browsingContextId
    });
  }
};

/**
 * Plugin stopping the running cell of the JavaScript kernels when the user
 * interrupts them: JupyterLite only cancels the queued cells.
 */
const kernelInterrupts: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/javascript-kernel-extension:interrupts',
  description: 'Stops the running cell of the JavaScript kernels on interrupt.',
  autoStart: true,
  optional: [IKernelClient],
  activate: (app: JupyterFrontEnd, client: IKernelClient | null) => {
    if (client) {
      installKernelInterrupts(client);
    }
  }
};

const plugins: Array<
  | JupyterFrontEndPlugin<IJavaScriptKernelStartupRegistry>
  | JupyterFrontEndPlugin<IKernelSettings>
  | JupyterFrontEndPlugin<void>
> = [
  startupExtensionsRegistry,
  kernelSettings,
  kernelIFrame,
  kernelWorker,
  kernelInterrupts
];

export default plugins;

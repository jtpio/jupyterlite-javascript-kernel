// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { IKernel, IKernelClient } from '@jupyterlite/services';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';

/**
 * The marker of the kernel clients whose interrupt calls the kernels.
 */
const INSTALLED = Symbol.for('@jupyterlite/javascript-kernel:interrupts');

/**
 * A kernel which can stop its running cell.
 */
interface IInterruptibleKernel extends IKernel {
  interrupt?: () => Promise<void>;
}

/**
 * Make the JupyterLite kernel client call the `interrupt()` method of the
 * kernels, like JavaScriptKernel.interrupt(), when the user interrupts them.
 *
 * JupyterLite cancels the queued cells on interrupt, but does not tell the
 * kernel, so the running cell would never stop. This wraps the interrupt()
 * of the client: it cancels the queued cells first, so that none starts
 * when the running cell stops, then calls the kernel, if it has an
 * interrupt() method. Installing it again on the same client does nothing,
 * so the extensions of several kernels can all call it.
 *
 * @returns A disposable restoring the interrupt() of the client.
 */
export function installKernelInterrupts(client: IKernelClient): IDisposable {
  const target = client as IKernelClient & { [INSTALLED]?: boolean };
  if (target[INSTALLED]) {
    return new DisposableDelegate(() => undefined);
  }

  // The kernels by id, also added later
  const kernels = new Map<string, IInterruptibleKernel>();
  const onChanged = (
    _: unknown,
    change: { type: string; key: string; newValue?: IKernel }
  ) => {
    if ((change.type === 'add' || change.type === 'set') && change.newValue) {
      kernels.set(change.key, change.newValue);
    } else if (change.type === 'remove') {
      kernels.delete(change.key);
    }
  };
  client.changed.connect(onChanged);

  const original = client.interrupt;
  const interrupt = async (kernelId: string): Promise<void> => {
    await original.call(client, kernelId);
    const kernel =
      kernels.get(kernelId) ??
      ((await client.getModel(kernelId)) as IInterruptibleKernel | undefined);
    if (typeof kernel?.interrupt === 'function') {
      await kernel.interrupt();
    }
  };
  client.interrupt = interrupt;
  target[INSTALLED] = true;

  return new DisposableDelegate(() => {
    client.changed.disconnect(onChanged);
    if (client.interrupt === interrupt) {
      client.interrupt = original;
    }
    delete target[INSTALLED];
  });
}

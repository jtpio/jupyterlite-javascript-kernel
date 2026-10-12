// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  Widget,
  type IWidgetChange,
  type WidgetTraitPair,
  _deserializeWidgetPair,
  _serializeWidgetPair
} from './widget';

export class DirectionalLink extends Widget {
  static override modelName = 'DirectionalLinkModel';
  static override viewName = null;

  protected override _defaults() {
    return {
      source: null,
      target: null
    };
  }

  constructor(
    state?: Record<string, unknown> & {
      source?: WidgetTraitPair;
      target?: WidgetTraitPair;
    }
  ) {
    super(state as Record<string, unknown>);
  }

  get source(): WidgetTraitPair | null {
    return (this.get('source') as WidgetTraitPair | null) ?? null;
  }
  set source(v: WidgetTraitPair | null) {
    this.set('source', v);
  }

  get target(): WidgetTraitPair | null {
    return (this.get('target') as WidgetTraitPair | null) ?? null;
  }
  set target(v: WidgetTraitPair | null) {
    this.set('target', v);
  }

  unlink(): void {
    this.close();
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if ((name === 'source' || name === 'target') && value !== undefined) {
      return _serializeWidgetPair(value as WidgetTraitPair | null);
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'source' || name === 'target') {
      return _deserializeWidgetPair(this._manager, value);
    }
    return super._deserializeProperty(name, value);
  }
}

export class Link extends DirectionalLink {
  static override modelName = 'LinkModel';
}

export function jslink(source: WidgetTraitPair, target: WidgetTraitPair): Link {
  return new Link({ source, target });
}

export function jsdlink(
  source: WidgetTraitPair,
  target: WidgetTraitPair
): DirectionalLink {
  return new DirectionalLink({ source, target });
}

/**
 * A link between the properties of two widgets made in the kernel, by
 * `link()` or `dlink()`.
 */
export interface IKernelLink {
  /**
   * The widget and the name of the property the values come from.
   */
  readonly source: WidgetTraitPair;

  /**
   * The widget and the name of the property the values go to.
   */
  readonly target: WidgetTraitPair;

  /**
   * Stop syncing the properties.
   */
  unlink(): void;
}

/**
 * A function changing the value of a property for another one.
 */
export type LinkTransform = (value: any) => unknown;

/**
 * Link two properties of widgets in the kernel, in both directions, like
 * `link()` of traitlets: the target gets the value of the source first.
 * Unlike `jslink()`, the values go through the kernel, and can be changed
 * on their way with `transform`, a pair of functions `[forward, backward]`
 * from the source to the target and back.
 */
export function link(
  source: WidgetTraitPair,
  target: WidgetTraitPair,
  transform?: [LinkTransform, LinkTransform]
): IKernelLink {
  if (
    transform !== undefined &&
    (!Array.isArray(transform) ||
      transform.length !== 2 ||
      transform.some(fn => typeof fn !== 'function'))
  ) {
    throw new TypeError(
      'The transform of link() must be a pair of functions [forward, backward]'
    );
  }
  const [forward, backward] = transform ?? [identity, identity];
  return new KernelLink(source, target, forward, backward);
}

/**
 * Link a property of a widget to another one in the kernel, in one
 * direction, like `dlink()` of traitlets: the target gets the value of the
 * source, changed by `transform` when given, now and when it changes.
 */
export function dlink(
  source: WidgetTraitPair,
  target: WidgetTraitPair,
  transform?: LinkTransform
): IKernelLink {
  if (transform !== undefined && typeof transform !== 'function') {
    throw new TypeError('The transform of dlink() must be a function');
  }
  return new KernelLink(source, target, transform ?? identity, null);
}

function identity(value: unknown): unknown {
  return value;
}

/**
 * Check a pair of a widget and the name of one of its properties.
 */
function checkPair(pair: unknown, name: string): WidgetTraitPair {
  if (
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    !(pair[0] instanceof Widget) ||
    typeof pair[1] !== 'string'
  ) {
    throw new TypeError(
      `The ${name} of a link must be a pair [widget, 'property']`
    );
  }
  return [pair[0], pair[1]];
}

/**
 * A link made in the kernel with observers of the widgets. While it sets
 * one property, it ignores the changes of the other one, like a value
 * clamped by the target, so that the values do not loop.
 */
class KernelLink implements IKernelLink {
  constructor(
    source: WidgetTraitPair,
    target: WidgetTraitPair,
    forward: LinkTransform,
    backward: LinkTransform | null
  ) {
    this.source = checkPair(source, 'source');
    this.target = checkPair(target, 'target');
    this._forward = this._observer(this.target, forward);
    this._backward = backward ? this._observer(this.source, backward) : null;

    this._forward({ new: read(this.source) } as IWidgetChange);
    this.source[0].observe(this._forward, this.source[1]);
    if (this._backward) {
      this.target[0].observe(this._backward, this.target[1]);
    }
  }

  readonly source: WidgetTraitPair;
  readonly target: WidgetTraitPair;

  unlink(): void {
    this.source[0].unobserve(this._forward, this.source[1]);
    if (this._backward) {
      this.target[0].unobserve(this._backward, this.target[1]);
    }
  }

  /**
   * An observer setting a property to the changed value, transformed.
   */
  private _observer(
    [widget, name]: WidgetTraitPair,
    transform: LinkTransform
  ): (change: IWidgetChange) => void {
    return change => {
      if (this._updating) {
        return;
      }
      this._updating = true;
      try {
        (widget as unknown as Record<string, unknown>)[name] = transform(
          change.new
        );
      } finally {
        this._updating = false;
      }
    };
  }

  private _forward: (change: IWidgetChange) => void;
  private _backward: ((change: IWidgetChange) => void) | null;
  private _updating = false;
}

/**
 * The value of a property of a widget, through its accessor, like the value
 * of a selection widget, derived from its index.
 */
function read([widget, name]: WidgetTraitPair): unknown {
  return (widget as unknown as Record<string, unknown>)[name];
}

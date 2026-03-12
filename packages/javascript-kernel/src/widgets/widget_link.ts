// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  Widget,
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

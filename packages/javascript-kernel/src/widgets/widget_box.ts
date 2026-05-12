// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget, Widget, _deserializeWidgetReference } from './widget';

/**
 * Serialize an array of Widget instances to `"IPY_MODEL_<id>"` references
 * as required by the Jupyter widget protocol.
 */
function _serializeChildren(children: Widget[]): string[] {
  return children.map(w => `IPY_MODEL_${w.commId}`);
}

function _deserializeChildren(
  manager: DOMWidget['_manager'],
  children: unknown
): Widget[] {
  if (!Array.isArray(children)) {
    return [];
  }

  return children
    .map(child => _deserializeWidgetReference(manager, child))
    .filter((child): child is Widget => child instanceof Widget);
}

export class Box extends DOMWidget {
  static override modelName = 'BoxModel';
  static override viewName = 'BoxView';

  constructor(state?: Record<string, unknown> & { children?: Widget[] }) {
    const { children, ...rest } = state ?? {};
    super({ ...rest, children: children ?? [] });
  }

  protected override _defaults() {
    return { ...super._defaults(), children: [], box_style: '' };
  }

  get children(): Widget[] {
    return [...((this.get('children') as Widget[]) ?? [])];
  }
  set children(v: Widget[]) {
    this.set('children', [...v]);
  }

  get box_style(): string {
    return this.get('box_style') as string;
  }
  set box_style(v: string) {
    this.set('box_style', v);
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if (name === 'children') {
      return _serializeChildren(
        Array.isArray(value) ? (value as Widget[]) : []
      );
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'children') {
      return _deserializeChildren(this._manager, value);
    }
    return super._deserializeProperty(name, value);
  }
}

export class HBox extends Box {
  static override modelName = 'HBoxModel';
  static override viewName = 'HBoxView';
}

export class VBox extends Box {
  static override modelName = 'VBoxModel';
  static override viewName = 'VBoxView';
}

export class GridBox extends Box {
  static override modelName = 'GridBoxModel';
  static override viewName = 'GridBoxView';
}

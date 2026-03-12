// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { DOMWidget } from './widget';

export class Button extends DOMWidget {
  static override modelName = 'ButtonModel';
  static override viewName = 'ButtonView';

  protected override _defaults() {
    return {
      ...super._defaults(),
      tooltip: '',
      icon: '',
      button_style: ''
    };
  }

  /**
   * Register a click handler.
   */
  onClick(callback: () => void): this {
    return this.on('click', callback);
  }

  get tooltip(): string {
    return this.get('tooltip') as string;
  }
  set tooltip(v: string) {
    this.set('tooltip', v);
  }
  get icon(): string {
    return this.get('icon') as string;
  }
  set icon(v: string) {
    this.set('icon', v);
  }
  get button_style(): string {
    return this.get('button_style') as string;
  }
  set button_style(v: string) {
    this.set('button_style', v);
  }

  protected override _handleMsg(
    data: Record<string, unknown>,
    buffers?: ArrayBuffer[]
  ): void {
    super._handleMsg(data, buffers);
    if (data.method === 'custom') {
      const content = data.content as Record<string, unknown> | undefined;
      if (content?.event === 'click') {
        this._trigger('click');
      }
      this._trigger('custom', content, buffers);
    }
  }
}

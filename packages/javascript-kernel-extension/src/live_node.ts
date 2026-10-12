// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { MimeModel, type IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { PanelLayout, Widget } from '@lumino/widgets';

import {
  IFrameRuntimeBackend,
  LIVE_NODE_MIME_TYPE,
  type ILiveNode
} from '@jupyterlite/javascript-kernel';

/**
 * The class of the outputs showing a live DOM node.
 */
const LIVE_NODE_CLASS = 'jp-JavaScriptLiveNode';

/**
 * The class of the HTML outputs, styling the live nodes like the snapshot
 * of their HTML.
 */
const RENDERED_HTML_CLASS = 'jp-RenderedHTMLCommon';

/**
 * The events of a live node forwarded to the document of the realm of the
 * cells, which bubble to its window: the ones of the mouse, the pointer and
 * the keyboard.
 */
const FORWARDED_EVENTS = [
  'click',
  'dblclick',
  'contextmenu',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'wheel',
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerover',
  'pointerout',
  'pointercancel',
  'keydown',
  'keyup',
  'keypress'
];

/**
 * The properties of the events copied to the forwarded events, from the
 * dictionaries of their constructors.
 */
const EVENT_INIT_KEYS = [
  'bubbles',
  'cancelable',
  'composed',
  'detail',
  'ctrlKey',
  'shiftKey',
  'altKey',
  'metaKey',
  'screenX',
  'screenY',
  'clientX',
  'clientY',
  'movementX',
  'movementY',
  'button',
  'buttons',
  'deltaX',
  'deltaY',
  'deltaZ',
  'deltaMode',
  'pointerId',
  'width',
  'height',
  'pressure',
  'tangentialPressure',
  'tiltX',
  'tiltY',
  'twist',
  'pointerType',
  'isPrimary',
  'key',
  'code',
  'location',
  'repeat',
  'isComposing',
  'charCode',
  'keyCode'
];

/**
 * The renderer of the LIVE_NODE_MIME_TYPE outputs: it moves the DOM node of
 * the output, an element of the realm of a JavaScript (IFrame) kernel, from
 * the iframe to the output, with its event listeners and its state, as the
 * iframe has the origin of the page.
 *
 * A node is in one place at a time: the last output rendering it has it,
 * and the others show its snapshot, until it comes back to them when that
 * output goes. Without the node, after a restart of the kernel or in a
 * notebook opened from a file, the output shows the snapshot of the node
 * saved with it, its HTML or the image of a canvas, with the renderer of
 * its MIME type.
 */
export class LiveNodeRenderer extends Widget implements IRenderMime.IRenderer {
  /**
   * @param registry - The rendermime registry, whose renderers show the
   * snapshots.
   */
  constructor(
    options: IRenderMime.IRendererOptions,
    registry: IRenderMimeRegistry
  ) {
    super();
    this._options = options;
    this._registry = registry;
    this.addClass(LIVE_NODE_CLASS);
    // Like the renderers of JupyterLab
    this.node.dataset.mimeType = options.mimeType;
    this.layout = new PanelLayout();
    for (const type of FORWARDED_EVENTS) {
      this.node.addEventListener(type, this._forward, { passive: false });
    }
  }

  /**
   * Show the node of an output, or its snapshot.
   */
  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const data = model.data[LIVE_NODE_MIME_TYPE] as { id?: unknown } | null;
    const id = typeof data?.id === 'string' ? data.id : null;
    const changed = model !== this._model;
    this._model = model;
    if (id !== this._id) {
      this._leave();
      this._id = id;
    }
    const live = id !== null ? IFrameRuntimeBackend.findLiveNode(id) : null;
    if (live && model.trusted) {
      this._take(live);
      return;
    }
    if (changed) {
      this._disposeSnapshot();
    }
    await this._showSnapshot();
  }

  /**
   * Dispose the renderer: its node goes back to the previous output
   * rendering it, if any.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._leave();
    super.dispose();
  }

  /**
   * Forward an event of the node to the document of the realm of the cells,
   * where it bubbles to the window: the listeners of the code of the cells
   * on them, like the ones of p5.js for `mouseX`, get the events of the node
   * as if it was still in the iframe. An event whose propagation stopped
   * before the output is not forwarded, and the page does the default action
   * of an event unless the listeners prevent it.
   */
  private _forward = (event: Event): void => {
    const document = this._live?.document;
    const view = document?.defaultView;
    if (!view || !this._live?.node.contains(event.target)) {
      return;
    }
    const name = event.constructor.name;
    const Constructor = view[name] ?? view.Event;
    const init: Record<string, unknown> = {};
    for (const key of EVENT_INIT_KEYS) {
      if (key in event) {
        init[key] = (event as any)[key];
      }
    }
    init.view = view;
    let forwarded: Event;
    try {
      forwarded = new Constructor(event.type, init);
    } catch {
      return;
    }
    document.dispatchEvent(forwarded);
    if (forwarded.defaultPrevented) {
      event.preventDefault();
    }
  };

  /**
   * Take the node from the other outputs rendering it, and show it.
   */
  private _take(live: ILiveNode): void {
    const id = this._id!;
    const renderers = (Private.renderers.get(id) ?? []).filter(
      renderer => renderer !== this
    );
    const previous = renderers[renderers.length - 1];
    renderers.push(this);
    Private.renderers.set(id, renderers);
    if (previous) {
      void previous._showSnapshot();
    }
    this._show(live);
  }

  /**
   * Stop rendering the node, and give it back to the previous output
   * rendering it.
   */
  private _leave(): void {
    const id = this._id;
    this._hideNode();
    if (id === null) {
      return;
    }
    const renderers = Private.renderers.get(id);
    if (!renderers?.includes(this)) {
      return;
    }
    const last = renderers[renderers.length - 1] === this;
    renderers.splice(renderers.indexOf(this), 1);
    if (renderers.length === 0) {
      Private.renderers.delete(id);
    } else if (last) {
      const live = IFrameRuntimeBackend.findLiveNode(id);
      const previous = renderers[renderers.length - 1];
      if (live) {
        previous._show(live);
      }
    }
  }

  /**
   * Show the node in place of the snapshot, until the runtime releases it.
   */
  private _show(live: ILiveNode): void {
    this._disposeSnapshot();
    this._live = live;
    this.addClass(RENDERED_HTML_CLASS);
    if (live.node.parentNode !== this.node) {
      this.node.appendChild(live.node);
    }
    void live.released.then(() => {
      if (this._live === live && !this.isDisposed) {
        void this._showSnapshot();
      }
    });
  }

  /**
   * Remove the node from the output, if it shows it.
   */
  private _hideNode(): void {
    const node = this._live?.node;
    this._live = null;
    this.removeClass(RENDERED_HTML_CLASS);
    if (node && node.parentNode === this.node) {
      node.remove();
    }
  }

  /**
   * Show the snapshot of the node, with the renderer of its MIME type.
   */
  private async _showSnapshot(): Promise<void> {
    this._hideNode();
    const model = this._model;
    if (this._snapshot || !model || this.isDisposed) {
      return;
    }
    const data = { ...model.data };
    delete data[LIVE_NODE_MIME_TYPE];
    const mimeType = this._registry.preferredMimeType(
      data,
      model.trusted ? 'any' : 'ensure'
    );
    const factory = mimeType ? this._registry.getFactory(mimeType) : undefined;
    if (!mimeType || !factory) {
      return;
    }
    const snapshot = factory.createRenderer({ ...this._options, mimeType });
    this._snapshot = snapshot;
    (this.layout as PanelLayout).addWidget(snapshot);
    await snapshot.renderModel(
      new MimeModel({ data, metadata: model.metadata, trusted: model.trusted })
    );
  }

  /**
   * Remove the snapshot of the node.
   */
  private _disposeSnapshot(): void {
    this._snapshot?.dispose();
    this._snapshot = null;
  }

  private _options: IRenderMime.IRendererOptions;
  private _registry: IRenderMimeRegistry;
  private _model: IRenderMime.IMimeModel | null = null;
  private _id: string | null = null;
  private _live: ILiveNode | null = null;
  private _snapshot: IRenderMime.IRenderer | null = null;
}

/**
 * The factory of the renderers of the live DOM nodes, ranked before the
 * HTML and the images of their snapshots. It is not safe: the outputs of an
 * untrusted notebook show the snapshot.
 */
export function createLiveNodeRendererFactory(
  registry: IRenderMimeRegistry
): IRenderMime.IRendererFactory {
  return {
    safe: false,
    mimeTypes: [LIVE_NODE_MIME_TYPE],
    defaultRank: 10,
    createRenderer: options => new LiveNodeRenderer(options, registry)
  };
}

namespace Private {
  /**
   * The renderers of the live nodes, by id, in the order they rendered
   * them: the last one shows the node.
   */
  export const renderers = new Map<string, LiveNodeRenderer[]>();
}

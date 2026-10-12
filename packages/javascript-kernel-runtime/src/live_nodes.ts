// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { uuid } from './env';

/**
 * The MIME type of the outputs showing a live DOM node of the kernel, like
 * an element which is the result of a cell: its data is the id of the node
 * in a LiveNodeRegistry, `{ id: string }`. The bundle also has a snapshot of
 * the node, its HTML or the image of a canvas, for the frontends and the
 * saved notebooks without the node.
 */
export const LIVE_NODE_MIME_TYPE =
  'application/vnd.jupyterlite.javascript-node+json';

/**
 * A live DOM node, found in a LiveNodeRegistry from its id.
 */
export interface ILiveNode {
  /**
   * The node, an element of the realm of the cells. Showing it moves it to
   * the page, with its event listeners and its state.
   */
  node: any;

  /**
   * The document of the realm of the cells, which had the node. The page
   * forwards it the events of the node, as its listeners, and the ones of
   * its window, would get them if the node was still in it.
   */
  document: any;

  /**
   * Settles when the registry releases the node, as the runtime stops, like
   * on a restart: the page then shows the snapshot of its output instead,
   * as the code of the cells does not run anymore.
   */
  released: Promise<void>;
}

/**
 * The DOM nodes shown live in the outputs, by id, for a host which can move
 * them from the realm of the cells to the page, like the IFrame kernel.
 *
 * The registry keeps the last `maxNodes` nodes, so that an output rendered
 * again, like in a notebook opened again on the running kernel, shows its
 * node again.
 */
export class LiveNodeRegistry {
  /**
   * @param document - The document of the realm of the cells: only its
   * elements are shown live.
   * @param maxNodes - The number of nodes the registry keeps,
   * `LiveNodeRegistry.MAX_NODES` by default.
   */
  constructor(document: any, maxNodes = LiveNodeRegistry.MAX_NODES) {
    this._document = document;
    this._maxNodes = maxNodes;
    this._release = this._newRelease();
  }

  /**
   * Whether a node can be shown live: an element of the document of the
   * realm, or one already shown live, but not the root, the head or the
   * body of the document, nor an element of another document, like the
   * page.
   */
  canShow(node: any): boolean {
    if (this._ids.has(node)) {
      return true;
    }
    const document = this._document;
    try {
      return (
        node?.ownerDocument === document &&
        node.nodeType === 1 &&
        node !== document.documentElement &&
        node !== document.head &&
        node !== document.body
      );
    } catch {
      return false;
    }
  }

  /**
   * Add a node to the registry, and return its id. A node added again keeps
   * its id, and becomes the last one added.
   */
  add(node: any): string {
    let id = this._ids.get(node);
    if (id === undefined) {
      id = `node-${uuid()}`;
      this._ids.set(node, id);
    }
    this._nodes.delete(id);
    this._nodes.set(id, node);
    for (const oldest of this._nodes.keys()) {
      if (this._nodes.size <= this._maxNodes) {
        break;
      }
      this._nodes.delete(oldest);
    }
    return id;
  }

  /**
   * The node of an id, or null when the registry does not have it.
   */
  get(id: string): ILiveNode | null {
    const node = this._nodes.get(id);
    return node === undefined
      ? null
      : { node, document: this._document, released: this._release.promise };
  }

  /**
   * Release all the nodes, when the runtime stops: the outputs showing them
   * show their snapshot instead.
   */
  clear(): void {
    this._nodes.clear();
    this._ids = new WeakMap();
    const release = this._release;
    this._release = this._newRelease();
    release.resolve();
  }

  private _newRelease(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    return { promise, resolve };
  }

  /**
   * The number of nodes a registry keeps by default.
   */
  static readonly MAX_NODES: number = 1000;

  private _document: any;
  private _maxNodes: number;
  private _nodes = new Map<string, any>();
  private _ids = new WeakMap<object, string>();
  private _release: { promise: Promise<void>; resolve: () => void };
}

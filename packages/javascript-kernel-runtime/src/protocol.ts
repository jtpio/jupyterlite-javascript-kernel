// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { KernelMessage } from '@jupyterlab/services';

/**
 * Output messages emitted by a runtime, for the kernel to publish.
 */
export type RuntimeOutputMessage =
  | {
      type: 'stream';
      bundle: KernelMessage.IStreamMsg['content'];
    }
  | {
      type: 'display_data';
      bundle: KernelMessage.IDisplayDataMsg['content'];
    }
  | {
      type: 'update_display_data';
      bundle: KernelMessage.IUpdateDisplayDataMsg['content'];
    }
  | {
      type: 'clear_output';
      bundle: KernelMessage.IClearOutputMsg['content'];
    }
  | {
      type: 'execute_result';
      bundle: KernelMessage.IExecuteResultMsg['content'];
    }
  | {
      type: 'execute_error';
      bundle: KernelMessage.IReplyErrorContent;
    }
  | {
      type: 'comm_open';
      content: {
        comm_id: string;
        target_name: string;
        data: Record<string, unknown>;
        target_module?: string;
      };
      metadata?: Record<string, unknown>;
      buffers?: ArrayBuffer[];
    }
  | {
      type: 'comm_msg';
      content: {
        comm_id: string;
        data: Record<string, unknown>;
      };
      metadata?: Record<string, unknown>;
      buffers?: ArrayBuffer[];
    }
  | {
      type: 'comm_close';
      content: {
        comm_id: string;
        data: Record<string, unknown>;
      };
      metadata?: Record<string, unknown>;
      buffers?: ArrayBuffer[];
    };

/**
 * Callback invoked when a runtime emits output.
 */
export type RuntimeOutputHandler = (message: RuntimeOutputMessage) => void;

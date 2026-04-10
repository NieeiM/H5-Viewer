import { readFileSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { type Manifest } from 'vite';
import {
  commands,
  type CustomDocument,
  type CustomReadonlyEditorProvider,
  type ExtensionContext,
  type LogOutputChannel,
  Uri,
  type Webview,
  type WebviewPanel,
  window,
} from 'vscode';

import { H5Service } from './h5-service.js';
import { type Message, MessageType, type RpcRequest } from './models.js';

export default class H5WebViewer implements CustomReadonlyEditorProvider {
  public constructor(
    private readonly context: ExtensionContext,
    private readonly outputChannel: LogOutputChannel,
  ) {}

  public async openCustomDocument(uri: Uri): Promise<CustomDocument> {
    return { uri, dispose: () => {} };
  }

  public async resolveCustomEditor(
    document: CustomDocument,
    webviewPanel: WebviewPanel,
  ): Promise<void> {
    const { webview } = webviewPanel;
    const { extensionUri } = this.context;

    // Allow opening files outside of workspace
    const resourceRoot = document.uri.with({
      path: document.uri.path.replace(/\/[^/]+?\.\w+$/u, '/'),
    });

    webview.options = {
      enableScripts: true,
      localResourceRoots: [extensionUri, resourceRoot],
    };

    // eslint-disable-next-line require-atomic-updates
    webview.html = await this.getHtmlForWebview(webview);

    // Create H5Service for this file
    const h5service = new H5Service();
    let serviceReady = false;

    webview.onDidReceiveMessage(async (evt: Message) => {
      // ---- Ready message ----
      if (evt.type === MessageType.Ready) {
        try {
          const filePath = document.uri.fsPath;
          const name = basename(filePath);
          const { size } = statSync(filePath);

          // Initialize h5wasm/node and open the file on the server side
          await h5service.init(filePath, this.context.extensionPath);
          serviceReady = true;

          this.outputChannel.info(`Opened HDF5 file: ${name} (${size} bytes)`);

          // Send file info to webview (no URI needed — data loaded via RPC)
          webview.postMessage({
            type: MessageType.FileInfo,
            data: { name, size },
          });

          // Watch for file changes on disk
          watchFile(filePath, async () => {
            try {
              await h5service.reopen(filePath);
              webview.postMessage({ type: MessageType.FileChanged });
            } catch (err) {
              this.outputChannel.warn(
                'Failed to reopen file after change:',
                err instanceof Error ? err.message : 'unknown error',
              );
            }
          });

          webviewPanel.onDidDispose(() => {
            unwatchFile(filePath);
            h5service.close();
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          this.outputChannel.error('Failed to initialize H5Service:', msg);
        }

        return;
      }

      // ---- RPC request messages ----
      if (evt.type === MessageType.RpcRequest) {
        const { id, method, params } = evt.data as RpcRequest;

        if (!serviceReady) {
          webview.postMessage({
            type: MessageType.RpcResponse,
            data: { id, error: 'H5Service not ready yet' },
          });
          return;
        }

        try {
          let result: unknown;

          switch (method) {
            case 'getEntity':
              result = h5service.getEntity(params.path as string);
              break;
            case 'getValue':
              result = h5service.getValue(
                params.path as string,
                params.selection as string | undefined,
              );
              break;
            case 'getAttrValues':
              result = h5service.getAttrValues(params.path as string);
              break;
            case 'getSearchablePaths':
              result = h5service.getSearchablePaths(params.path as string);
              break;
            default:
              throw new Error(`Unknown RPC method: ${method}`);
          }

          webview.postMessage({
            type: MessageType.RpcResponse,
            data: { id, result },
          });
        } catch (err) {
          const errorMsg =
            err instanceof Error ? err.message : 'Unknown error';
          this.outputChannel.warn(`RPC ${method} error:`, errorMsg);
          webview.postMessage({
            type: MessageType.RpcResponse,
            data: { id, error: errorMsg },
          });
        }

        return;
      }

      // ---- Export message ----
      if (evt.type === MessageType.Export) {
        const { format, name, payload } = evt.data;

        const defaultUri = Uri.file(
          join(dirname(document.uri.fsPath), `${name}.${format}`),
        );

        const saveUri = await window.showSaveDialog({
          defaultUri,
          title: `Export to ${format.toUpperCase()}`,
        });

        if (saveUri) {
          writeFileSync(saveUri.fsPath, payload);

          // Open output file in separate editor
          commands.executeCommand('workbench.action.keepEditor');

          try {
            await window.showTextDocument(saveUri);
          } catch (error) {
            this.outputChannel.warn(
              'Unable to open file:',
              error instanceof Error ? error.message : 'unknown error',
            );
          }
        }
      }
    });
  }

  private async getHtmlForWebview(webview: Webview): Promise<string> {
    const { extensionPath, extensionUri } = this.context;
    const { cspSource } = webview;

    const manifest = JSON.parse(
      readFileSync(join(extensionPath, 'dist/.vite/manifest.json'), 'utf-8'),
    ) as Manifest;

    const [{ file: jsPath, css }] = Object.values(manifest);
    if (css === undefined) {
      throw new Error('Expected manifest to include `css` files array');
    }

    const [cssPath] = css;
    const jsPathOnDisk = Uri.joinPath(extensionUri, 'dist', jsPath);
    const cssPathOnDisk = Uri.joinPath(extensionUri, 'dist', cssPath);

    const jsUri = webview.asWebviewUri(jsPathOnDisk);
    const cssUri = webview.asWebviewUri(cssPathOnDisk);

    // Plugins are now loaded in the extension host (Node.js side),
    // so no plugins script tag or connect-src needed.
    const cspRules = [
      "default-src 'none'",
      `script-src ${cspSource} 'unsafe-eval'`,
      `style-src ${cspSource}`,
      'img-src blob:',
      'worker-src blob:',
    ];

    return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta
          http-equiv="Content-Security-Policy"
          content="${cspRules.join('; ')};"
        >
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>H5Web</title>
        <script type="module" src="${jsUri.toString()}"></script>
        <link rel="stylesheet" href="${cssUri.toString()}">
			</head>
			<body>
				<div id="root"></div>
			</body>
			</html>`;
  }
}

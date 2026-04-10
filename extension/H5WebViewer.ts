import { readFileSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

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

import { CntService } from './cnt-service.js';
import { H5Service, type Logger } from './h5-service.js';
import { MatService } from './mat-service.js';
import { detectMatVersion, isHdf5File, type MatVersion } from './mat-version.js';
import { type FileInfo, type Message, MessageType, type RpcRequest } from './models.js';

/** Rough estimate of JSON-serialized size for logging */
function estimateSize(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    const bytes = json ? json.length : 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    return '? B';
  }
}

/** Unified service interface (both H5Service and MatService implement these) */
interface DataService {
  getEntity(path: string): unknown;
  getValue(path: string, selection?: string): unknown;
  getAttrValues(path: string): Record<string, unknown>;
  getSearchablePaths(rootPath: string): string[];
  getAudioHints(): unknown[];
  getAudioData(path: string): unknown;
  getJsonHints(): unknown[];
  getJsonData(path: string): unknown;
  close(): void;
}

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

    let service: DataService | null = null;
    let serviceReady = false;
    let rpcCount = 0;

    // Create a logger that wraps the VS Code LogOutputChannel
    const logger: Logger = {
      info: (msg, ...args) => this.outputChannel.info(msg, ...args),
      warn: (msg, ...args) => this.outputChannel.warn(msg, ...args),
      error: (msg, ...args) => this.outputChannel.error(msg, ...args),
      debug: (msg, ...args) => this.outputChannel.debug(msg, ...args),
      trace: (msg, ...args) => this.outputChannel.trace(msg, ...args),
    };

    // File name/size are captured once on Ready and included in all progress messages
    let currentFileName = '';
    let currentFileSize = 0;

    const sendProgress = (message: string, percent = -1) => {
      webview.postMessage({
        type: MessageType.LoadingProgress,
        data: { message, percent, fileName: currentFileName, fileSize: currentFileSize },
      });
    };

    webview.onDidReceiveMessage(async (evt: Message) => {
      // ---- Ready message ----
      if (evt.type === MessageType.Ready) {
        try {
          const filePath = document.uri.fsPath;
          const name = basename(filePath);
          const { size } = statSync(filePath);
          const ext = extname(filePath).toLowerCase();

          // Send initial progress immediately so webview can show file info
          currentFileName = name;
          currentFileSize = size;
          sendProgress(`Opening ${name}...`);

          // Determine file format and initialize appropriate service
          const { fileInfo, dataService } = await this.initService(
            filePath, name, size, ext, sendProgress, logger,
          );

          if (fileInfo.errorMessage) {
            // Unsupported format — send error to webview
            webview.postMessage({ type: MessageType.FileInfo, data: fileInfo });
            return;
          }

          service = dataService!;
          serviceReady = true;

          this.outputChannel.info(
            `Opened file: ${name} (${(size / 1024 / 1024).toFixed(1)} MB, format: ${fileInfo.format})`,
          );

          webview.postMessage({ type: MessageType.FileInfo, data: fileInfo });

          // Watch for file changes on disk
          watchFile(filePath, async () => {
            try {
              if (service instanceof H5Service) {
                await service.reopen(filePath);
              }
              // For MAT files, we'd need to re-parse the entire file
              // which is expensive. Just notify the webview.
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
            service?.close();
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown error';
          this.outputChannel.error('Failed to initialize service:', msg);
          sendProgress(`Error: ${msg}`, -1);
        }

        return;
      }

      // ---- RPC request messages ----
      if (evt.type === MessageType.RpcRequest) {
        const { id, method, params } = evt.data as RpcRequest;
        const rpcId = ++rpcCount;
        const t0 = performance.now();

        const paramSummary = method === 'getValue'
          ? `path=${params.path}, selection=${params.selection ?? 'full'}`
          : `path=${params.path}`;

        this.outputChannel.debug(`[RPC #${rpcId}] → ${method}(${paramSummary})`);

        if (!serviceReady || !service) {
          this.outputChannel.warn(`[RPC #${rpcId}] Service not ready, rejecting`);
          webview.postMessage({
            type: MessageType.RpcResponse,
            data: { id, error: 'Service not ready yet' },
          });
          return;
        }

        try {
          let result: unknown;

          switch (method) {
            case 'getEntity':
              result = service.getEntity(params.path as string);
              break;
            case 'getValue':
              result = service.getValue(
                params.path as string,
                params.selection as string | undefined,
              );
              break;
            case 'getAttrValues':
              result = service.getAttrValues(params.path as string);
              break;
            case 'getSearchablePaths':
              result = service.getSearchablePaths(params.path as string);
              break;
            case 'getAudioHints':
              result = service.getAudioHints();
              break;
            case 'getAudioData':
              result = service.getAudioData(params.path as string);
              break;
            case 'getJsonHints':
              result = service.getJsonHints();
              break;
            case 'getJsonData':
              result = service.getJsonData(params.path as string);
              break;
            default:
              throw new Error(`Unknown RPC method: ${method}`);
          }

          const elapsed = (performance.now() - t0).toFixed(1);
          const size = estimateSize(result);
          this.outputChannel.debug(`[RPC #${rpcId}] ← ${method} OK (${elapsed} ms, ~${size})`);

          webview.postMessage({
            type: MessageType.RpcResponse,
            data: { id, result },
          });
        } catch (err) {
          const errorMsg =
            err instanceof Error ? err.message : 'Unknown error';
          const elapsed = (performance.now() - t0).toFixed(1);
          this.outputChannel.warn(`[RPC #${rpcId}] ← ${method} ERROR (${elapsed} ms): ${errorMsg}`);
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

  // ---------------------------------------------------------------------------
  // Format detection + service initialization
  // ---------------------------------------------------------------------------

  private async initService(
    filePath: string,
    name: string,
    size: number,
    ext: string,
    sendProgress: (message: string, percent?: number) => void,
    logger: Logger,
  ): Promise<{ fileInfo: FileInfo; dataService?: DataService }> {
    // .mat files need version detection
    if (ext === '.mat') {
      return this.initMatService(filePath, name, size, sendProgress, logger);
    }

    // .cnt files: auto-detect Neuroscan vs ANT Neuro
    if (ext === '.cnt') {
      return this.initCntService(filePath, name, size, sendProgress, logger);
    }

    // All other extensions: try HDF5 first
    // (some extensions like .nc might not actually be HDF5)
    try {
      if (!isHdf5File(filePath)) {
        return {
          fileInfo: {
            name, size,
            errorMessage: `This file does not appear to be a valid HDF5 file. ` +
              `The extension "${ext}" was expected to be HDF5-based, but the file ` +
              `header does not contain the HDF5 signature.`,
          },
        };
      }
    } catch {
      // If we can't read the header, try opening anyway
    }

    sendProgress('Initializing HDF5 reader...');
    const h5service = new H5Service(logger);
    await h5service.init(filePath, this.context.extensionPath);

    return {
      fileInfo: { name, size, format: 'hdf5' },
      dataService: h5service,
    };
  }

  private async initMatService(
    filePath: string,
    name: string,
    size: number,
    sendProgress: (message: string, percent?: number) => void,
    logger: Logger,
  ): Promise<{ fileInfo: FileInfo; dataService?: DataService }> {
    sendProgress('Detecting MAT file version...');

    const version = detectMatVersion(filePath);
    this.outputChannel.info(`MAT version detected: ${version} for ${name}`);

    // v7.3 = HDF5, use H5Service
    if (version === 'v7.3') {
      sendProgress('Opening MAT v7.3 (HDF5) file...');
      const h5service = new H5Service(logger);
      await h5service.init(filePath, this.context.extensionPath);
      return {
        fileInfo: { name, size, format: 'mat-v73' },
        dataService: h5service,
      };
    }

    // v5 / v7: use MatService (full file load)
    if (version === 'v5' || version === 'v7') {
      const sizeMB = (size / 1024 / 1024).toFixed(1);

      const matService = new MatService(logger);
      await matService.init(filePath, version, (msg) => {
        sendProgress(msg);
      });

      return {
        fileInfo: { name, size, format: version === 'v5' ? 'mat-v5' : 'mat-v7' },
        dataService: matService,
      };
    }

    // v4 or unknown: not supported
    const versionLabel = version === 'v4' ? 'MAT v4' : `unrecognized format (${version})`;
    return {
      fileInfo: {
        name,
        size,
        errorMessage:
          `This file uses ${versionLabel}, which is not supported.\n\n` +
          `Supported MAT versions:\n` +
          `  - MAT v7.3 (HDF5-based) — full support\n` +
          `  - MAT v5 / v7 — full support (loaded into memory)\n\n` +
          `To convert, open the file in MATLAB and resave:\n` +
          `  load('${name}');\n` +
          `  save('${name}', '-v7.3');`,
      },
    };
  }

  private async initCntService(
    filePath: string,
    name: string,
    size: number,
    sendProgress: (message: string, percent?: number) => void,
    logger: Logger,
  ): Promise<{ fileInfo: FileInfo; dataService?: DataService }> {
    const cntService = new CntService(logger);
    const format = await cntService.init(filePath, (msg) => {
      sendProgress(msg);
    });

    const formatLabel = format === 'neuroscan' ? 'cnt-neuroscan' : 'cnt-ant';
    return {
      fileInfo: { name, size, format: formatLabel as FileInfo['format'] },
      dataService: cntService,
    };
  }

  // ---------------------------------------------------------------------------
  // HTML generation
  // ---------------------------------------------------------------------------

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

    const cspRules = [
      "default-src 'none'",
      `script-src ${cspSource} 'unsafe-eval'`,
      `style-src ${cspSource} 'unsafe-inline'`,
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
				<title>H5 Viewer</title>
        <script type="module" src="${jsUri.toString()}"></script>
        <link rel="stylesheet" href="${cssUri.toString()}">
        <style>
          #preload-screen {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100vh;
            font-family: system-ui, -apple-system, sans-serif;
            color: #888;
            background: #1e1e1e;
          }
          #preload-screen .spinner {
            width: 28px;
            height: 28px;
            border: 3px solid #333;
            border-top-color: #4ec9b0;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-bottom: 16px;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          #preload-screen .text {
            font-size: 13px;
            opacity: 0.7;
          }
        </style>
			</head>
			<body>
				<div id="root">
          <div id="preload-screen">
            <div class="spinner"></div>
            <div class="text">Loading H5 Viewer...</div>
          </div>
        </div>
			</body>
			</html>`;
  }
}

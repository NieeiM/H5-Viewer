import { type ExtensionContext, window } from 'vscode';

import H5WebViewer from './H5WebViewer';

const EDITOR_IDS = ['h5viewer.viewer', 'h5viewer.fallback-viewer'];

export function activate(context: ExtensionContext): void {
  const outputChannel = window.createOutputChannel('H5 Viewer', { log: true });

  context.subscriptions.push(
    ...EDITOR_IDS.map((id) =>
      window.registerCustomEditorProvider(
        id,
        new H5WebViewer(context, outputChannel),
        {
          webviewOptions: { retainContextWhenHidden: true },
          supportsMultipleEditorsPerDocument: true,
        },
      ),
    ),
  );
}

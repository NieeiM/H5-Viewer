import { App as H5WebApp } from '@h5web/app';
import { useEventListener } from '@react-hookz/web';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { type FileInfo, type Message, MessageType } from '../extension/models';
import RemoteProvider from './RemoteProvider';
import { vscode } from './vscode-api';

function App() {
  const [fileInfo, setFileInfo] = useState<FileInfo>();
  const [revision, setRevision] = useState(0);

  useEventListener(globalThis, 'message', (evt: MessageEvent<Message>) => {
    const { data: message } = evt;
    if (message.type === MessageType.FileInfo) {
      setFileInfo(message.data);
    }
    if (message.type === MessageType.FileChanged) {
      // File was modified on disk — bump revision to force re-render
      setRevision((r) => r + 1);
    }
  });

  useEffect(() => {
    vscode.postMessage({ type: MessageType.Ready });
  }, []);

  if (!fileInfo) {
    return <p>Connecting to H5 service...</p>;
  }

  if (fileInfo.size === 0) {
    // e.g. when comparing git changes on an untracked file
    return <p>File does not exist</p>;
  }

  if (fileInfo.size < 0) {
    // Error during initialization
    return <p>Failed to open HDF5 file. Check the H5Web output channel for details.</p>;
  }

  return (
    <ErrorBoundary
      fallbackRender={({ error }) => (
        <p>{error instanceof Error ? error.message : 'Unknown error'}</p>
      )}
    >
      <Suspense fallback={<p>Loading HDF5 file structure...</p>}>
        <RemoteProvider key={revision} filepath={fileInfo.name}>
          <H5WebApp />
        </RemoteProvider>
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;

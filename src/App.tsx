import { App as H5WebApp } from '@h5web/app';
import { useEventListener } from '@react-hookz/web';
import { Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import {
  type FileInfo,
  type LoadingProgress,
  type Message,
  MessageType,
} from '../extension/models';
import RemoteProvider from './RemoteProvider';
import { vscode } from './vscode-api';

const FORMAT_LABELS: Record<string, string> = {
  'hdf5': 'HDF5',
  'mat-v73': 'MAT v7.3 (HDF5)',
  'mat-v5': 'MAT v5',
  'mat-v7': 'MAT v7',
};

function App() {
  const [fileInfo, setFileInfo] = useState<FileInfo>();
  const [revision, setRevision] = useState(0);
  const [progress, setProgress] = useState<LoadingProgress | null>(null);

  useEventListener(globalThis, 'message', (evt: MessageEvent<Message>) => {
    const { data: message } = evt;
    if (message.type === MessageType.FileInfo) {
      setFileInfo(message.data);
      setProgress(null); // Loading complete
    }
    if (message.type === MessageType.FileChanged) {
      setRevision((r) => r + 1);
    }
    if (message.type === MessageType.LoadingProgress) {
      setProgress(message.data);
    }
  });

  useEffect(() => {
    vscode.postMessage({ type: MessageType.Ready });
  }, []);

  // Still connecting — no messages received yet
  if (!fileInfo && !progress) {
    return <div style={styles.container}><p>Connecting to service...</p></div>;
  }

  // Loading in progress (MAT v5/v7 full file load)
  if (!fileInfo && progress) {
    return (
      <div style={styles.container}>
        <div style={styles.progressBox}>
          <p style={styles.progressText}>{progress.message}</p>
          {progress.percent >= 0 ? (
            <div style={styles.progressBarOuter}>
              <div
                style={{
                  ...styles.progressBarInner,
                  width: `${progress.percent}%`,
                }}
              />
            </div>
          ) : (
            <div style={styles.progressBarOuter}>
              <div style={styles.progressBarIndeterminate} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!fileInfo) {
    return null;
  }

  // Error message from extension (unsupported format, etc.)
  if (fileInfo.errorMessage) {
    return (
      <div style={styles.container}>
        <div style={styles.errorBox}>
          <h3 style={styles.errorTitle}>Cannot open file</h3>
          <pre style={styles.errorMessage}>{fileInfo.errorMessage}</pre>
        </div>
      </div>
    );
  }

  if (fileInfo.size === 0) {
    return <div style={styles.container}><p>File does not exist</p></div>;
  }

  // Format badge for MAT v5/v7 (reminder that data is fully loaded in memory)
  const formatLabel = fileInfo.format ? FORMAT_LABELS[fileInfo.format] : undefined;
  const isMatLegacy = fileInfo.format === 'mat-v5' || fileInfo.format === 'mat-v7';

  return (
    <ErrorBoundary
      fallbackRender={({ error }) => (
        <div style={styles.container}>
          <p>{error instanceof Error ? error.message : 'Unknown error'}</p>
        </div>
      )}
    >
      {isMatLegacy && (
        <div style={styles.banner}>
          {formatLabel} — Entire file loaded into memory ({(fileInfo.size / 1024 / 1024).toFixed(1)} MB).
          For better performance with large files, resave as MAT v7.3:
          <code style={styles.code}> save('file.mat', '-v7.3')</code>
        </div>
      )}
      <Suspense fallback={
        <div style={styles.container}>
          <p>{progress?.message || 'Loading file structure...'}</p>
        </div>
      }>
        <RemoteProvider key={revision} filepath={fileInfo.name}>
          <H5WebApp />
        </RemoteProvider>
      </Suspense>
    </ErrorBoundary>
  );
}

// Inline styles to avoid depending on CSS modules
const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    padding: '2rem',
    color: '#ccc',
    fontFamily: 'system-ui, sans-serif',
  },
  progressBox: {
    textAlign: 'center',
    maxWidth: 400,
    width: '100%',
  },
  progressText: {
    marginBottom: '1rem',
    fontSize: '0.9rem',
  },
  progressBarOuter: {
    height: 4,
    background: '#333',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarInner: {
    height: '100%',
    background: '#4ec9b0',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
  progressBarIndeterminate: {
    height: '100%',
    width: '30%',
    background: '#4ec9b0',
    borderRadius: 2,
    animation: 'indeterminate 1.5s infinite ease-in-out',
  },
  errorBox: {
    maxWidth: 600,
    padding: '1.5rem',
    background: '#1e1e1e',
    border: '1px solid #444',
    borderRadius: 8,
  },
  errorTitle: {
    margin: '0 0 1rem',
    color: '#f48771',
  },
  errorMessage: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    fontSize: '0.85rem',
    lineHeight: 1.6,
    color: '#ccc',
  },
  banner: {
    padding: '6px 12px',
    background: '#2d2d00',
    color: '#ccc',
    fontSize: '0.8rem',
    borderBottom: '1px solid #555',
  },
  code: {
    background: '#333',
    padding: '1px 4px',
    borderRadius: 3,
    fontFamily: 'monospace',
  },
};

export default App;

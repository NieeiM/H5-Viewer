import { App as H5WebApp } from '@h5web/app';
import { useEventListener } from '@react-hookz/web';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import {
  type FileInfo,
  type LoadingProgress,
  type Message,
  MessageType,
} from '../extension/models';
import AudioPanel from './audio/AudioPanel';
import { RpcClient } from './remote-api';
import RemoteProvider from './RemoteProvider';
import { vscode } from './vscode-api';

const FORMAT_LABELS: Record<string, string> = {
  'hdf5': 'HDF5',
  'mat-v73': 'MAT v7.3 (HDF5)',
  'mat-v5': 'MAT v5',
  'mat-v7': 'MAT v7',
  'cnt-neuroscan': 'Neuroscan CNT',
  'cnt-ant': 'ANT Neuro CNT',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Loading screen component
// ---------------------------------------------------------------------------

function LoadingScreen({ progress }: { progress: LoadingProgress | null }) {
  const fileName = progress?.fileName;
  const fileSize = progress?.fileSize;
  const message = progress?.message || 'Initializing...';

  return (
    <div style={styles.loadingContainer}>
      <div style={styles.loadingCard}>
        {/* Spinner */}
        <div style={styles.spinner} />

        {/* File info */}
        {fileName && (
          <div style={styles.fileInfo}>
            <div style={styles.fileName}>{fileName}</div>
            {fileSize !== undefined && fileSize > 0 && (
              <div style={styles.fileSizeText}>{formatSize(fileSize)}</div>
            )}
          </div>
        )}

        {/* Current step */}
        <div style={styles.stepText}>{message}</div>

        {/* Progress bar */}
        {progress && progress.percent >= 0 ? (
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
            <div style={styles.progressBarPulse} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

function App() {
  const [fileInfo, setFileInfo] = useState<FileInfo>();
  const [revision, setRevision] = useState(0);
  const [progress, setProgress] = useState<LoadingProgress | null>(null);

  // Single RpcClient shared by RemoteProvider and AudioPanel
  const rpc = useMemo(() => new RpcClient(vscode), []);

  useEventListener(globalThis, 'message', (evt: MessageEvent<Message>) => {
    const { data: message } = evt;
    if (message.type === MessageType.FileInfo) {
      setFileInfo(message.data);
      setProgress(null);
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

  // Still loading (no FileInfo yet) — show loading screen
  if (!fileInfo) {
    return <LoadingScreen progress={progress} />;
  }

  // Error message from extension (unsupported format, etc.)
  if (fileInfo.errorMessage) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.errorBox}>
          <h3 style={styles.errorTitle}>Cannot open file</h3>
          <pre style={styles.errorMessage}>{fileInfo.errorMessage}</pre>
        </div>
      </div>
    );
  }

  if (fileInfo.size === 0) {
    return <div style={styles.loadingContainer}><p style={{ color: '#888' }}>File does not exist</p></div>;
  }

  // Format badge for MAT v5/v7
  const formatLabel = fileInfo.format ? FORMAT_LABELS[fileInfo.format] : undefined;
  const isMatLegacy = fileInfo.format === 'mat-v5' || fileInfo.format === 'mat-v7';

  return (
    <ErrorBoundary
      fallbackRender={({ error }) => (
        <div style={styles.loadingContainer}>
          <p style={{ color: '#f48771' }}>{error instanceof Error ? error.message : 'Unknown error'}</p>
        </div>
      )}
    >
      {isMatLegacy && (
        <div style={styles.banner}>
          {formatLabel} — Entire file loaded into memory ({formatSize(fileInfo.size)}).
          For better performance with large files, resave as MAT v7.3:
          <code style={styles.code}> save('file.mat', '-v7.3')</code>
        </div>
      )}
      <div style={styles.mainLayout}>
        <div style={styles.viewerArea}>
          <Suspense fallback={<LoadingScreen progress={progress} />}>
            <RemoteProvider key={revision} filepath={fileInfo.name} rpc={rpc}>
              <H5WebApp />
            </RemoteProvider>
          </Suspense>
        </div>
        <AudioPanel rpc={rpc} />
      </div>
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  mainLayout: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
  },
  viewerArea: {
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
  },
  loadingContainer: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    padding: '2rem',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    background: '#1e1e1e',
  },
  loadingCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    maxWidth: 380,
    width: '100%',
    gap: '12px',
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid #333',
    borderTopColor: '#4ec9b0',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
    marginBottom: 4,
  },
  fileInfo: {
    textAlign: 'center' as const,
  },
  fileName: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#ddd',
    wordBreak: 'break-all' as const,
  },
  fileSizeText: {
    fontSize: '12px',
    color: '#888',
    marginTop: 2,
  },
  stepText: {
    fontSize: '12px',
    color: '#999',
    textAlign: 'center' as const,
  },
  progressBarOuter: {
    width: '100%',
    height: 3,
    background: '#333',
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressBarInner: {
    height: '100%',
    background: '#4ec9b0',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
  progressBarPulse: {
    height: '100%',
    width: '40%',
    background: 'linear-gradient(90deg, transparent, #4ec9b0, transparent)',
    borderRadius: 2,
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  errorBox: {
    maxWidth: 600,
    padding: '1.5rem',
    background: '#252526',
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

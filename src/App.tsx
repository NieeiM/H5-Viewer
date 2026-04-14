import { App as H5WebApp } from '@h5web/app';
import { useEventListener } from '@react-hookz/web';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import {
  type FileInfo,
  type LoadingProgress,
  type Message,
  MessageType,
} from '../extension/models';
import AudioViewer from './audio/AudioViewer';
import JsonViewer from './json/JsonViewer';
import { RpcClient } from './remote-api';
import RemoteProvider from './RemoteProvider';
import { vscode } from './vscode-api';

// ---------------------------------------------------------------------------
// View mode detection
// ---------------------------------------------------------------------------

type ViewMode = 'h5web' | 'audio' | 'json';

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|aac|m4a|opus|wma)$/i;
const JSON_EXT = /\.json$/i;

function detectViewMode(path: string): ViewMode {
  const name = path.split('/').pop() || '';
  if (AUDIO_EXT.test(name)) return 'audio';
  if (JSON_EXT.test(name)) return 'json';
  return 'h5web';
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

const FORMAT_LABELS: Record<string, string> = {
  'hdf5': 'HDF5', 'mat-v73': 'MAT v7.3 (HDF5)', 'mat-v5': 'MAT v5',
  'mat-v7': 'MAT v7', 'cnt-neuroscan': 'Neuroscan CNT', 'cnt-ant': 'ANT Neuro CNT',
  'safetensors': 'SafeTensors', 'gguf': 'GGUF',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------

function LoadingScreen({ progress }: { progress: LoadingProgress | null }) {
  return (
    <div className="h5v-loading-container">
      <div className="h5v-loading-card">
        <div className="h5v-spinner" />
        {progress?.fileName && (
          <div style={{ textAlign: 'center' }}>
            <div className="h5v-file-name">{progress.fileName}</div>
            {progress.fileSize !== undefined && progress.fileSize > 0 && (
              <div className="h5v-file-size">{formatSize(progress.fileSize)}</div>
            )}
          </div>
        )}
        <div className="h5v-step-text">{progress?.message || 'Initializing...'}</div>
        <div className="h5v-progress-outer">
          {progress && progress.percent >= 0
            ? <div className="h5v-progress-inner" style={{ width: `${progress.percent}%` }} />
            : <div className="h5v-progress-pulse" />}
        </div>
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
  const [viewMode, setViewMode] = useState<ViewMode>('h5web');
  const [activePath, setActivePath] = useState('');

  const rpc = useMemo(() => new RpcClient(vscode), []);

  useEventListener(globalThis, 'message', (evt: MessageEvent<Message>) => {
    const { data: message } = evt;
    if (message.type === MessageType.FileInfo) { setFileInfo(message.data); setProgress(null); }
    if (message.type === MessageType.FileChanged) { setRevision((r) => r + 1); }
    if (message.type === MessageType.LoadingProgress) { setProgress(message.data); }
  });

  useEffect(() => { vscode.postMessage({ type: MessageType.Ready }); }, []);

  const handlePathAccess = useCallback((path: string) => {
    const mode = detectViewMode(path);
    setViewMode(mode);
    setActivePath(path);
  }, []);

  const handleBack = useCallback(() => {
    setViewMode('h5web');
    setActivePath('');
  }, []);

  if (!fileInfo) return <LoadingScreen progress={progress} />;

  if (fileInfo.errorMessage) {
    return (
      <div className="h5v-loading-container">
        <div className="h5v-error-box">
          <h3 className="h5v-error-title">Cannot open file</h3>
          <pre className="h5v-error-msg">{fileInfo.errorMessage}</pre>
        </div>
      </div>
    );
  }

  if (fileInfo.size === 0) {
    return <div className="h5v-loading-container"><p>File does not exist</p></div>;
  }

  const isMatLegacy = fileInfo.format === 'mat-v5' || fileInfo.format === 'mat-v7';
  const activeDatasetName = activePath.split('/').pop() || '';

  return (
    <ErrorBoundary
      fallbackRender={({ error }) => (
        <div className="h5v-loading-container">
          <p style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </div>
      )}
    >
      {isMatLegacy && (
        <div className="h5v-banner">
          {FORMAT_LABELS[fileInfo.format!]} — Entire file loaded into memory ({formatSize(fileInfo.size)}).
          <code className="h5v-code"> save('file.mat', '-v7.3')</code>
        </div>
      )}

      {/*
        View switching: h5web / audio / json are mutually exclusive.
        @h5web/app is hidden (not unmounted) when audio/json is active,
        so file tree state is preserved. User clicks "Back" to return.
      */}
      <div className="h5v-root">
        {/* @h5web/app — always mounted, hidden when audio/json active */}
        <div style={{ display: viewMode === 'h5web' ? 'contents' : 'none' }}>
          <Suspense fallback={<LoadingScreen progress={progress} />}>
            <RemoteProvider key={revision} filepath={fileInfo.name} rpc={rpc} onPathAccess={handlePathAccess}>
              <H5WebApp />
            </RemoteProvider>
          </Suspense>
        </div>

        {/* Audio viewer */}
        {viewMode === 'audio' && activePath && (
          <AudioViewer rpc={rpc} path={activePath} name={activeDatasetName} onBack={handleBack} />
        )}

        {/* JSON viewer */}
        {viewMode === 'json' && activePath && (
          <JsonViewer rpc={rpc} path={activePath} name={activeDatasetName} onBack={handleBack} />
        )}
      </div>
    </ErrorBoundary>
  );
}

export default App;

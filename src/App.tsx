import { App as H5WebApp } from '@h5web/app';
import { useEventListener } from '@react-hookz/web';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
// Hook: observe @h5web/app's mainArea rect for overlay positioning
// ---------------------------------------------------------------------------

interface Rect { left: number; top: number; width: number; height: number }

function useMainAreaRect(rootRef: React.RefObject<HTMLDivElement | null>): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let mainArea: HTMLElement | null = null;
    let resizeObs: ResizeObserver | null = null;
    let mutationObs: MutationObserver | null = null;

    const measure = () => {
      if (!mainArea || !root) return;
      const r = mainArea.getBoundingClientRect();
      const rootR = root.getBoundingClientRect();
      setRect({
        left: r.left - rootR.left,
        top: r.top - rootR.top,
        width: r.width,
        height: r.height,
      });
    };

    const setup = () => {
      mainArea = root.querySelector('[class*="mainArea"]');
      if (mainArea) {
        measure();
        resizeObs = new ResizeObserver(measure);
        resizeObs.observe(mainArea);
        resizeObs.observe(root);
      }
    };

    mutationObs = new MutationObserver(() => { if (!mainArea) setup(); });
    mutationObs.observe(root, { childList: true, subtree: true });
    setup();

    return () => { resizeObs?.disconnect(); mutationObs?.disconnect(); };
  }, [rootRef]);

  return rect;
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
          {progress && progress.percent >= 0 ? (
            <div className="h5v-progress-inner" style={{ width: `${progress.percent}%` }} />
          ) : (
            <div className="h5v-progress-pulse" />
          )}
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
  const h5webRootRef = useRef<HTMLDivElement>(null);
  const mainAreaRect = useMainAreaRect(h5webRootRef);

  useEventListener(globalThis, 'message', (evt: MessageEvent<Message>) => {
    const { data: message } = evt;
    if (message.type === MessageType.FileInfo) { setFileInfo(message.data); setProgress(null); }
    if (message.type === MessageType.FileChanged) { setRevision((r) => r + 1); }
    if (message.type === MessageType.LoadingProgress) { setProgress(message.data); }
  });

  useEffect(() => { vscode.postMessage({ type: MessageType.Ready }); }, []);

  const handlePathAccess = useCallback((path: string) => {
    setViewMode(detectViewMode(path));
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
  const showOverlay = viewMode !== 'h5web' && activePath && mainAreaRect;

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

      <div className="h5v-root" ref={h5webRootRef}>
        {/* @h5web/app always rendered — sidebar stays visible */}
        <Suspense fallback={<LoadingScreen progress={progress} />}>
          <RemoteProvider key={revision} filepath={fileInfo.name} rpc={rpc} onPathAccess={handlePathAccess}>
            <H5WebApp />
          </RemoteProvider>
        </Suspense>

        {/* Overlay: positioned exactly over @h5web/app's mainArea */}
        {showOverlay && (
          <div
            className="h5v-overlay"
            style={{
              left: mainAreaRect.left,
              top: mainAreaRect.top,
              width: mainAreaRect.width,
              height: mainAreaRect.height,
            }}
          >
            {viewMode === 'audio' && (
              <AudioViewer rpc={rpc} path={activePath} name={activePath.split('/').pop() || ''} onBack={handleBack} />
            )}
            {viewMode === 'json' && (
              <JsonViewer rpc={rpc} path={activePath} name={activePath.split('/').pop() || ''} onBack={handleBack} />
            )}
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}

export default App;

/**
 * JSON viewer — replaces @h5web/app's right panel when a .json dataset is selected.
 */

import { useCallback, useEffect, useState } from 'react';

import type { RpcClient } from '../remote-api';

interface Props {
  rpc: RpcClient;
  path: string;
  name: string;
  onBack: () => void;
}

interface DetectionInfo {
  category: string; mime: string; ext: string; label: string; mismatchWarning?: string;
}

export default function JsonViewer({ rpc, path, name, onBack }: Props) {
  const [jsonStr, setJsonStr] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wordWrap, setWordWrap] = useState(true);
  const [detection, setDetection] = useState<DetectionInfo | null>(null);

  useEffect(() => {
    rpc.call('detectDatasetType', { path }).then((r) => setDetection(r as DetectionInfo)).catch(() => {});
  }, [rpc, path]);

  useEffect(() => {
    setLoading(true);
    setError('');
    setJsonStr('');
    rpc.call('getJsonData', { path }).then((result) => {
      setJsonStr((result as { json: string }).json);
    }).catch((e) => {
      setError(e instanceof Error ? e.message : 'Failed to load JSON');
    }).finally(() => setLoading(false));
  }, [rpc, path]);

  const copy = useCallback(() => { navigator.clipboard.writeText(jsonStr).catch(() => {}); }, [jsonStr]);

  // Keyboard: Escape to go back
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <div className="h5v-overlay-inner">
      {/* Header + format badge */}
      <div className="h5v-panel-header">
        <button className="h5v-back-btn" onClick={onBack}>← Back</button>
        <span style={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'var(--vscode-symbolIcon-objectForeground, #dcdcaa)' }}>{'{ }'}</span>
        <span className="h5v-panel-title">{name}</span>
        {detection && <span className="h5v-format-badge">{detection.label}</span>}
        <span className="h5v-panel-path">{path}</span>
      </div>

      {detection?.mismatchWarning && (
        <div className="h5v-mismatch-warning">⚠ {detection.mismatchWarning}</div>
      )}

      {/* Toolbar */}
      <div className="h5v-panel-toolbar">
        <button className="h5v-tool-btn" onClick={copy}>Copy</button>
        <label className="h5v-wrap-label">
          <input type="checkbox" checked={wordWrap} onChange={(e) => setWordWrap(e.target.checked)} />
          Word Wrap
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--vscode-descriptionForeground, #666)' }}>
          Esc: back
        </span>
      </div>

      {error && <div className="h5v-panel-error">{error}</div>}
      {loading && <div className="h5v-panel-loading"><div className="h5v-spinner" /><span>Loading JSON...</span></div>}

      {jsonStr && !loading && (
        <div className="h5v-panel-body">
          <pre
            className="h5v-json-code"
            style={{
              whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
              wordBreak: wordWrap ? 'break-all' : 'normal',
            }}
          >
            {colorize(jsonStr)}
          </pre>
        </div>
      )}
    </div>
  );
}

function colorize(json: string): React.ReactNode[] {
  const lines = json.split('\n');
  const out: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
      .replace(/"([^"\\]|\\.)*"\s*:/g, (m) => `\x01K${m}\x01E`)
      .replace(/:\s*"([^"\\]|\\.)*"/g, (m) => `\x01S${m}\x01E`)
      .replace(/:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m) => `\x01N${m}\x01E`)
      .replace(/:\s*(true|false|null)/g, (m) => `\x01B${m}\x01E`);

    const segs = line.split('\x01');
    const els: React.ReactNode[] = [];

    for (let j = 0; j < segs.length; j++) {
      const s = segs[j];
      const cls = s[0] === 'K' ? 'h5v-json-key' : s[0] === 'S' ? 'h5v-json-str' : s[0] === 'N' ? 'h5v-json-num' : s[0] === 'B' ? 'h5v-json-bool' : '';
      const txt = cls ? s.slice(1).replace(/E$/, '') : s.replace(/E$/, '');
      els.push(cls ? <span key={`${i}-${j}`} className={cls}>{txt}</span> : <span key={`${i}-${j}`}>{txt}</span>);
    }

    out.push(<span key={i}>{els}{i < lines.length - 1 ? '\n' : ''}</span>);
  }

  return out;
}

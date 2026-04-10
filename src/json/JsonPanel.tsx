/**
 * Collapsible panel for viewing JSON datasets stored in HDF5/MAT files.
 * Displays formatted, syntax-highlighted JSON with expand/collapse.
 */

import { useCallback, useEffect, useState } from 'react';

import type { JsonHint } from '../../extension/models';
import type { RpcClient } from '../remote-api';

interface Props {
  rpc: RpcClient;
}

export default function JsonPanel({ rpc }: Props) {
  const [hints, setHints] = useState<JsonHint[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const [jsonStr, setJsonStr] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [wordWrap, setWordWrap] = useState(true);

  // Load JSON hints on mount
  useEffect(() => {
    rpc.call('getJsonHints', {}).then((result) => {
      const h = result as JsonHint[];
      setHints(h);
      if (h.length > 0) setSelectedPath(h[0].path);
    }).catch(() => {});
  }, [rpc]);

  // Load JSON data when selection changes
  useEffect(() => {
    if (!selectedPath) return;
    setLoading(true);
    setError('');
    setJsonStr('');

    rpc.call('getJsonData', { path: selectedPath }).then((result) => {
      const res = result as { json: string; parsed: unknown };
      setJsonStr(res.json);
    }).catch((e) => {
      setError(e instanceof Error ? e.message : 'Failed to load JSON');
    }).finally(() => {
      setLoading(false);
    });
  }, [selectedPath, rpc]);

  const copyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(jsonStr).catch(() => {});
  }, [jsonStr]);

  if (hints.length === 0) return null;

  return (
    <div style={styles.panel}>
      <div style={styles.header} onClick={() => setCollapsed(!collapsed)}>
        <span style={styles.arrow}>{collapsed ? '▶' : '▼'}</span>
        <span style={styles.headerText}>
          JSON Viewer ({hints.length} dataset{hints.length > 1 ? 's' : ''})
        </span>
      </div>

      {!collapsed && (
        <div>
          {/* Selector */}
          {hints.length > 1 && (
            <div style={styles.selector}>
              <select
                value={selectedPath}
                onChange={(e) => setSelectedPath(e.target.value)}
                style={styles.select}
              >
                {hints.map((h) => (
                  <option key={h.path} value={h.path}>{h.path}</option>
                ))}
              </select>
            </div>
          )}

          {/* Toolbar */}
          <div style={styles.toolbar}>
            <button onClick={copyToClipboard} style={styles.toolBtn} title="Copy to clipboard">
              Copy
            </button>
            <label style={styles.wrapLabel}>
              <input
                type="checkbox"
                checked={wordWrap}
                onChange={(e) => setWordWrap(e.target.checked)}
              />
              <span style={{ marginLeft: 4 }}>Wrap</span>
            </label>
            {selectedPath && (
              <span style={styles.pathLabel}>{selectedPath}</span>
            )}
          </div>

          {/* Error */}
          {error && <div style={styles.error}>{error}</div>}

          {/* Loading */}
          {loading && <div style={styles.loading}>Loading JSON...</div>}

          {/* JSON content */}
          {jsonStr && !loading && (
            <div style={styles.codeContainer}>
              <pre style={{
                ...styles.code,
                whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                wordBreak: wordWrap ? 'break-all' : 'normal',
              }}>
                {colorizeJson(jsonStr)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Simple JSON syntax colorizer using regex.
 * Returns an array of React elements with colored spans.
 */
function colorizeJson(json: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Regex to match JSON tokens
  const regex = /("(?:\\.|[^"\\])*")\s*:/g;  // keys
  const strRegex = /:\s*("(?:\\.|[^"\\])*")/g;  // string values
  const numRegex = /:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;  // numbers
  const boolRegex = /:\s*(true|false|null)/g;  // booleans

  // For simplicity, just split by lines and color per-line tokens
  const lines = json.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colored = line
      .replace(/"([^"\\]|\\.)*"\s*:/g, (m) => `\x01KEY${m}\x01END`)
      .replace(/:\s*"([^"\\]|\\.)*"/g, (m) => `\x01STR${m}\x01END`)
      .replace(/:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m) => `\x01NUM${m}\x01END`)
      .replace(/:\s*(true|false|null)/g, (m) => `\x01BOOL${m}\x01END`);

    const segments = colored.split('\x01');
    const lineElements: React.ReactNode[] = [];

    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j];
      if (seg.startsWith('KEY')) {
        lineElements.push(<span key={`${i}-${j}`} style={{ color: '#9cdcfe' }}>{seg.slice(3).replace(/END$/, '')}</span>);
      } else if (seg.startsWith('STR')) {
        lineElements.push(<span key={`${i}-${j}`} style={{ color: '#ce9178' }}>{seg.slice(3).replace(/END$/, '')}</span>);
      } else if (seg.startsWith('NUM')) {
        lineElements.push(<span key={`${i}-${j}`} style={{ color: '#b5cea8' }}>{seg.slice(3).replace(/END$/, '')}</span>);
      } else if (seg.startsWith('BOOL')) {
        lineElements.push(<span key={`${i}-${j}`} style={{ color: '#569cd6' }}>{seg.slice(4).replace(/END$/, '')}</span>);
      } else {
        lineElements.push(<span key={`${i}-${j}`}>{seg.replace(/END$/, '')}</span>);
      }
    }

    parts.push(<span key={i}>{lineElements}{i < lines.length - 1 ? '\n' : ''}</span>);
  }

  return parts;
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    borderTop: '2px solid #3c3c3c',
    background: '#1e1e1e',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    cursor: 'pointer',
    userSelect: 'none',
    background: '#252526',
    borderBottom: '1px solid #3c3c3c',
  },
  arrow: {
    fontSize: '10px',
    color: '#ccc',
  },
  headerText: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#ccc',
  },
  selector: {
    padding: '6px 12px',
    borderBottom: '1px solid #3c3c3c',
  },
  select: {
    width: '100%',
    padding: '4px 8px',
    background: '#3c3c3c',
    color: '#ccc',
    border: '1px solid #555',
    borderRadius: 3,
    fontSize: '12px',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 12px',
    borderBottom: '1px solid #3c3c3c',
    background: '#252526',
  },
  toolBtn: {
    padding: '2px 8px',
    background: '#3c3c3c',
    color: '#ccc',
    border: '1px solid #555',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: '11px',
  },
  wrapLabel: {
    fontSize: '11px',
    color: '#999',
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
  },
  pathLabel: {
    fontSize: '11px',
    color: '#666',
    marginLeft: 'auto',
    fontFamily: 'monospace',
  },
  error: {
    padding: '8px 12px',
    background: '#3b1111',
    color: '#f48771',
    fontSize: '12px',
  },
  loading: {
    padding: '12px',
    color: '#888',
    fontSize: '12px',
    textAlign: 'center',
  },
  codeContainer: {
    maxHeight: 400,
    overflow: 'auto',
    background: '#1e1e1e',
  },
  code: {
    margin: 0,
    padding: '8px 12px',
    fontSize: '12px',
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
    lineHeight: 1.5,
    color: '#d4d4d4',
    tabSize: 2,
  },
};

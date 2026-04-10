/**
 * Full-screen JSON viewer for a single dataset.
 * Displays formatted, syntax-highlighted JSON.
 */

import { useCallback, useEffect, useState } from 'react';

import type { RpcClient } from '../remote-api';

interface Props {
  rpc: RpcClient;
  /** HDF5 path to the JSON dataset */
  path: string;
  /** Display name */
  name: string;
}

export default function JsonViewer({ rpc, path, name }: Props) {
  const [jsonStr, setJsonStr] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wordWrap, setWordWrap] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    setJsonStr('');

    rpc.call('getJsonData', { path }).then((result) => {
      const res = result as { json: string; parsed: unknown };
      setJsonStr(res.json);
    }).catch((e) => {
      setError(e instanceof Error ? e.message : 'Failed to load JSON');
    }).finally(() => {
      setLoading(false);
    });
  }, [rpc, path]);

  const copyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(jsonStr).catch(() => {});
  }, [jsonStr]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.icon}>{ }</span>
        <span style={styles.title}>{name}</span>
        <span style={styles.pathLabel}>{path}</span>
      </div>

      <div style={styles.toolbar}>
        <button onClick={copyToClipboard} style={styles.toolBtn}>Copy</button>
        <label style={styles.wrapLabel}>
          <input
            type="checkbox"
            checked={wordWrap}
            onChange={(e) => setWordWrap(e.target.checked)}
          />
          <span style={{ marginLeft: 4 }}>Word Wrap</span>
        </label>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {loading && (
        <div style={styles.loading}>
          <div style={styles.spinner} />
          <span>Loading JSON...</span>
        </div>
      )}

      {jsonStr && !loading && (
        <div style={styles.codeContainer}>
          <pre style={{
            ...styles.code,
            whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
            wordBreak: wordWrap ? 'break-all' as const : 'normal' as const,
          }}>
            {colorizeJson(jsonStr)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Simple JSON syntax colorizer.
 */
function colorizeJson(json: string): React.ReactNode[] {
  const lines = json.split('\n');
  const parts: React.ReactNode[] = [];

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
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#1e1e1e',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    background: '#252526',
    borderBottom: '1px solid #3c3c3c',
    flexShrink: 0,
  },
  icon: {
    fontSize: '14px',
    color: '#dcdcaa',
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },
  title: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#ddd',
  },
  pathLabel: {
    fontSize: '11px',
    color: '#666',
    fontFamily: 'monospace',
    marginLeft: 'auto',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '4px 16px',
    background: '#252526',
    borderBottom: '1px solid #3c3c3c',
    flexShrink: 0,
  },
  toolBtn: {
    padding: '3px 10px',
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
  error: {
    padding: '12px 16px',
    background: '#3b1111',
    color: '#f48771',
    fontSize: '12px',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '40px',
    color: '#888',
    fontSize: '13px',
  },
  spinner: {
    width: 20,
    height: 20,
    border: '2px solid #333',
    borderTopColor: '#4ec9b0',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  codeContainer: {
    flex: 1,
    overflow: 'auto',
    background: '#1e1e1e',
  },
  code: {
    margin: 0,
    padding: '12px 16px',
    fontSize: '13px',
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
    lineHeight: 1.6,
    color: '#d4d4d4',
    tabSize: 2,
  },
};

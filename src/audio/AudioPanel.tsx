/**
 * Collapsible audio panel that lists audio datasets and provides
 * playback + waveform + spectrogram visualization.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AudioHint } from '../../extension/models';
import { type RpcClient } from '../remote-api';
import AudioPlayer from './AudioPlayer';
import Waveform from './Waveform';
import Spectrogram from './Spectrogram';

interface Props {
  rpc: RpcClient;
  /** Called after audio hints are loaded */
  onAudioDetected?: (count: number) => void;
}

// TypedArray reconstruction (same logic as remote-api.ts)
function deserializeTypedArray(obj: Record<string, unknown>): Float32Array | null {
  if (obj.__typedArray !== true) return null;
  const data = obj.data as number[];
  // Always convert to Float32 for AudioBuffer
  return new Float32Array(data);
}

export default function AudioPanel({ rpc, onAudioDetected }: Props) {
  const [hints, setHints] = useState<AudioHint[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [currentTime, setCurrentTime] = useState(0);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);

  // Load audio hints on mount
  useEffect(() => {
    rpc.call('getAudioHints', {}).then((result) => {
      const h = result as AudioHint[];
      setHints(h);
      onAudioDetected?.(h.length);
      // Auto-select first audio dataset
      if (h.length > 0) {
        setSelectedPath(h[0].path);
      }
    }).catch(() => {
      // No audio datasets — that's fine
    });
  }, [rpc, onAudioDetected]);

  const selectedHint = useMemo(
    () => hints.find((h) => h.path === selectedPath),
    [hints, selectedPath],
  );

  // Load audio data when selection changes
  useEffect(() => {
    if (!selectedPath || !selectedHint) return;

    // Safety check — if there's a warning and user hasn't acknowledged, don't load
    if (selectedHint.warning && !warningAcknowledged) return;

    setLoading(true);
    setError('');
    setAudioBuffer(null);

    rpc.call('getAudioData', { path: selectedPath }).then(async (result) => {
      const res = result as Record<string, unknown>;

      if (res.type === 'encoded') {
        // Encoded blob (mp3/wav/flac) — decode with AudioContext
        const bytes = new Uint8Array(res.data as number[]);
        try {
          const ctx = new AudioContext();
          const buffer = await ctx.decodeAudioData(bytes.buffer);
          setAudioBuffer(buffer);
          ctx.close();
        } catch (e) {
          setError(`Failed to decode audio: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      } else if (res.type === 'pcm') {
        // PCM array — build AudioBuffer directly
        const sampleRate = (res.sampleRate as number) || 44100;
        const numChannels = (res.numChannels as number) || 1;
        const numSamples = (res.numSamples as number) || 0;
        const channelFirst = res.channelFirst as boolean;

        const rawData = res.data as Record<string, unknown>;
        let flat: Float32Array;
        const deserialized = deserializeTypedArray(rawData);
        if (deserialized) {
          flat = deserialized;
        } else if (Array.isArray(rawData)) {
          flat = new Float32Array(rawData as number[]);
        } else {
          setError('Unexpected PCM data format');
          return;
        }

        try {
          const ctx = new AudioContext({ sampleRate });
          const buffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

          if (numChannels === 1) {
            buffer.copyToChannel(new Float32Array(flat), 0);
          } else if (channelFirst) {
            // [ch0_s0, ch0_s1, ..., ch1_s0, ch1_s1, ...]
            for (let ch = 0; ch < numChannels; ch++) {
              const chData = flat.slice(ch * numSamples, (ch + 1) * numSamples);
              buffer.copyToChannel(chData, ch);
            }
          } else {
            // Interleaved: [ch0_s0, ch1_s0, ch0_s1, ch1_s1, ...]
            for (let ch = 0; ch < numChannels; ch++) {
              const chData = new Float32Array(numSamples);
              for (let s = 0; s < numSamples; s++) {
                chData[s] = flat[s * numChannels + ch];
              }
              buffer.copyToChannel(chData, ch);
            }
          }

          setAudioBuffer(buffer);
          ctx.close();
        } catch (e) {
          setError(`Failed to create AudioBuffer: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      }
    }).catch((e) => {
      setError(`Failed to load audio data: ${e instanceof Error ? e.message : 'unknown error'}`);
    }).finally(() => {
      setLoading(false);
    });
  }, [selectedPath, selectedHint, warningAcknowledged, rpc]);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  if (hints.length === 0) return null;

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header} onClick={() => setCollapsed(!collapsed)}>
        <span style={styles.arrow}>{collapsed ? '▶' : '▼'}</span>
        <span style={styles.headerText}>
          Audio Player ({hints.length} dataset{hints.length > 1 ? 's' : ''})
        </span>
      </div>

      {!collapsed && (
        <div>
          {/* Dataset selector */}
          {hints.length > 1 && (
            <div style={styles.selector}>
              <select
                value={selectedPath}
                onChange={(e) => {
                  setSelectedPath(e.target.value);
                  setWarningAcknowledged(false);
                }}
                style={styles.select}
              >
                {hints.map((h) => (
                  <option key={h.path} value={h.path}>
                    {h.path} ({h.audioType === 'encoded-blob' ? 'encoded' : 'PCM'})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Warning for large datasets */}
          {selectedHint?.warning && !warningAcknowledged && (
            <div style={styles.warning}>
              <span>{selectedHint.warning}</span>
              <button
                style={styles.warningBtn}
                onClick={() => setWarningAcknowledged(true)}
              >
                Load anyway
              </button>
            </div>
          )}

          {/* Error */}
          {error && <div style={styles.error}>{error}</div>}

          {/* Loading */}
          {loading && <div style={styles.loadingBar}>Loading audio data...</div>}

          {/* Player + Visualizations */}
          {audioBuffer && !loading && (
            <>
              <AudioPlayer audioBuffer={audioBuffer} onTimeUpdate={handleTimeUpdate} />
              <Waveform audioBuffer={audioBuffer} currentTime={currentTime} />
              <Spectrogram audioBuffer={audioBuffer} currentTime={currentTime} />
            </>
          )}
        </div>
      )}
    </div>
  );
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
  warning: {
    padding: '8px 12px',
    background: '#4d3a00',
    color: '#ffcc00',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  warningBtn: {
    padding: '3px 10px',
    background: '#665500',
    color: '#ffcc00',
    border: '1px solid #888',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: '11px',
    flexShrink: 0,
  },
  error: {
    padding: '8px 12px',
    background: '#3b1111',
    color: '#f48771',
    fontSize: '12px',
  },
  loadingBar: {
    padding: '12px',
    color: '#888',
    fontSize: '12px',
    textAlign: 'center',
  },
};

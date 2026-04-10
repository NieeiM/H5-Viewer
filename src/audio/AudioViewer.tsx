/**
 * Full-screen audio viewer for a single dataset.
 * Displays playback controls, waveform, and spectrogram.
 */

import { useCallback, useEffect, useState } from 'react';

import type { RpcClient } from '../remote-api';
import AudioPlayer from './AudioPlayer';
import Waveform from './Waveform';
import Spectrogram from './Spectrogram';

interface Props {
  rpc: RpcClient;
  /** HDF5 path to the audio dataset */
  path: string;
  /** Display name */
  name: string;
}

// TypedArray reconstruction
function deserializeTypedArray(obj: Record<string, unknown>): Float32Array | null {
  if (obj.__typedArray !== true) return null;
  const data = obj.data as number[];
  return new Float32Array(data);
}

export default function AudioViewer({ rpc, path, name }: Props) {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError('');
    setAudioBuffer(null);

    rpc.call('getAudioData', { path }).then(async (result) => {
      const res = result as Record<string, unknown>;

      if (res.type === 'encoded') {
        const bytes = new Uint8Array(res.data as number[]);
        try {
          const ctx = new AudioContext();
          const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
          setAudioBuffer(buffer);
          ctx.close();
        } catch (e) {
          setError(`Failed to decode audio: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      } else if (res.type === 'pcm') {
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
            for (let ch = 0; ch < numChannels; ch++) {
              const chData = flat.slice(ch * numSamples, (ch + 1) * numSamples);
              buffer.copyToChannel(chData, ch);
            }
          } else {
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
      setError(`Failed to load audio: ${e instanceof Error ? e.message : 'unknown error'}`);
    }).finally(() => {
      setLoading(false);
    });
  }, [rpc, path]);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.icon}>♪</span>
        <span style={styles.title}>{name}</span>
        <span style={styles.pathLabel}>{path}</span>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {loading && (
        <div style={styles.loading}>
          <div style={styles.spinner} />
          <span>Loading audio data...</span>
        </div>
      )}

      {audioBuffer && !loading && (
        <>
          <AudioPlayer audioBuffer={audioBuffer} onTimeUpdate={handleTimeUpdate} />
          <div style={styles.vizArea}>
            <Waveform audioBuffer={audioBuffer} currentTime={currentTime} height={140} />
            <Spectrogram audioBuffer={audioBuffer} currentTime={currentTime} height={280} />
          </div>
        </>
      )}
    </div>
  );
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
    fontSize: '16px',
    color: '#4ec9b0',
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
  vizArea: {
    flex: 1,
    overflow: 'auto',
  },
};

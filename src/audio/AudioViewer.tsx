/**
 * Audio viewer — replaces @h5web/app's right panel when an audio dataset is selected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RpcClient } from '../remote-api';
import AudioPlayer from './AudioPlayer';
import Waveform from './Waveform';
import Spectrogram from './Spectrogram';

interface Props {
  rpc: RpcClient;
  path: string;
  name: string;
  onBack: () => void;
}

function deserializeTypedArray(obj: Record<string, unknown>): Float32Array | null {
  if (obj.__typedArray !== true) return null;
  return new Float32Array(obj.data as number[]);
}

export default function AudioViewer({ rpc, path, name, onBack }: Props) {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef<{ seek: (t: number) => void; toggle: () => void } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load audio data
  useEffect(() => {
    setLoading(true);
    setError('');
    setAudioBuffer(null);

    rpc.call('getAudioData', { path }).then(async (result) => {
      const res = result as Record<string, unknown>;

      if (res.type === 'encoded') {
        const bytes = new Uint8Array(res.data as number[]);
        const ctx = new AudioContext();
        try {
          const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
          setAudioBuffer(buf);
        } catch (e) {
          setError(`Failed to decode: ${e instanceof Error ? e.message : 'unknown'}`);
        } finally {
          ctx.close();
        }
      } else if (res.type === 'pcm') {
        const sr = (res.sampleRate as number) || 44100;
        const nch = (res.numChannels as number) || 1;
        const ns = (res.numSamples as number) || 0;
        const chFirst = res.channelFirst as boolean;
        const raw = res.data as Record<string, unknown>;
        const flat = deserializeTypedArray(raw) || new Float32Array(Array.isArray(raw) ? raw as number[] : []);

        try {
          const ctx = new AudioContext({ sampleRate: sr });
          const buf = ctx.createBuffer(nch, ns, sr);
          if (nch === 1) {
            buf.copyToChannel(new Float32Array(flat), 0);
          } else if (chFirst) {
            for (let ch = 0; ch < nch; ch++) buf.copyToChannel(flat.slice(ch * ns, (ch + 1) * ns), ch);
          } else {
            for (let ch = 0; ch < nch; ch++) {
              const d = new Float32Array(ns);
              for (let s = 0; s < ns; s++) d[s] = flat[s * nch + ch];
              buf.copyToChannel(d, ch);
            }
          }
          setAudioBuffer(buf);
          ctx.close();
        } catch (e) {
          setError(`Failed to create AudioBuffer: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      }
    }).catch((e) => {
      setError(`Failed to load: ${e instanceof Error ? e.message : 'unknown'}`);
    }).finally(() => setLoading(false));
  }, [rpc, path]);

  // Keyboard shortcuts
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        playerRef.current?.toggle();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentTime((t) => { const nt = Math.max(0, t - 5); playerRef.current?.seek(nt); return nt; });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const dur = audioBuffer?.duration || 0;
        setCurrentTime((t) => { const nt = Math.min(dur, t + 5); playerRef.current?.seek(nt); return nt; });
      } else if (e.key === 'Escape') {
        onBack();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [audioBuffer, onBack]);

  const handleTimeUpdate = useCallback((t: number) => setCurrentTime(t), []);

  const handleSeekFromViz = useCallback((t: number) => {
    setCurrentTime(t);
    playerRef.current?.seek(t);
  }, []);

  return (
    <div className="h5v-overlay-inner" ref={containerRef} tabIndex={-1} style={{ outline: 'none' }}>
      {/* Header with back button */}
      <div className="h5v-panel-header">
        <button className="h5v-back-btn" onClick={onBack}>← Back</button>
        <span style={{ fontSize: 16, color: 'var(--vscode-progressBar-background, #4ec9b0)' }}>♪</span>
        <span className="h5v-panel-title">{name}</span>
        <span className="h5v-panel-path">{path}</span>
      </div>

      {error && <div className="h5v-panel-error">{error}</div>}
      {loading && <div className="h5v-panel-loading"><div className="h5v-spinner" /><span>Loading audio...</span></div>}

      {audioBuffer && !loading && (
        <>
          <AudioPlayer audioBuffer={audioBuffer} onTimeUpdate={handleTimeUpdate} ref={playerRef} />
          <div className="h5v-panel-body">
            <Waveform audioBuffer={audioBuffer} currentTime={currentTime} onSeek={handleSeekFromViz} />
            <Spectrogram audioBuffer={audioBuffer} currentTime={currentTime} onSeek={handleSeekFromViz} />
          </div>
          <div style={{ padding: '4px 12px', fontSize: 10, color: 'var(--vscode-descriptionForeground, #666)' }}>
            Space: play/pause · ←/→: seek ±5s · Esc: back · Click waveform/spectrogram to seek
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Full audio viewer — player, waveform, spectrogram, settings, info table.
 * Adapted from vscode-audio-preview (MIT).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RpcClient } from '../remote-api';
import AudioPlayer, { type AudioPlayerHandle } from './AudioPlayer';
import Waveform from './Waveform';
import Spectrogram from './Spectrogram';
import {
  defaultSettings, WINDOW_SIZES, encodeWav,
  type AnalysisSettings, type FrequencyScale,
} from './audio-utils';

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

interface DetectionInfo {
  label: string;
  mismatchWarning?: string;
}

export default function AudioViewer({ rpc, path, name, onBack }: Props) {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detection, setDetection] = useState<DetectionInfo | null>(null);
  const [settings, setSettings] = useState<AnalysisSettings | null>(null);
  const [settingsTab, setSettingsTab] = useState<'hide' | 'player' | 'analyze' | 'cut'>('hide');

  // Player filter settings
  const [hpfEnabled, setHpfEnabled] = useState(false);
  const [hpfFreq, setHpfFreq] = useState(100);
  const [lpfEnabled, setLpfEnabled] = useState(false);
  const [lpfFreq, setLpfFreq] = useState(10000);

  const playerRef = useRef<AudioPlayerHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wavePlayheadRef = useRef<HTMLDivElement>(null);
  const specPlayheadRef = useRef<HTMLDivElement>(null);
  const playheadRefs = useRef([wavePlayheadRef, specPlayheadRef]);

  // Detect content type
  useEffect(() => {
    rpc.call('detectDatasetType', { path }).then((r) => setDetection(r as DetectionInfo)).catch(() => {});
  }, [rpc, path]);

  // Load audio data
  useEffect(() => {
    setLoading(true);
    setError('');
    setAudioBuffer(null);

    rpc.call('getAudioData', { path }).then(async (result) => {
      const res = result as Record<string, unknown>;

      let buf: AudioBuffer;
      if (res.type === 'encoded') {
        const bytes = new Uint8Array(res.data as number[]);
        const ctx = new AudioContext();
        try { buf = await ctx.decodeAudioData(bytes.buffer.slice(0)); } finally { ctx.close(); }
      } else {
        const sr = (res.sampleRate as number) || 44100;
        const nch = (res.numChannels as number) || 1;
        const ns = (res.numSamples as number) || 0;
        const chFirst = res.channelFirst as boolean;
        const raw = res.data as Record<string, unknown>;
        const flat = deserializeTypedArray(raw) || new Float32Array(Array.isArray(raw) ? raw as number[] : []);

        const ctx = new AudioContext({ sampleRate: sr });
        buf = ctx.createBuffer(nch, ns, sr);
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
        ctx.close();
      }

      setAudioBuffer(buf);
      // Initialize analysis settings from audio data
      const ch0 = buf.getChannelData(0);
      setSettings(defaultSettings(buf.sampleRate, buf.duration, ch0));
    }).catch((e) => {
      setError(e instanceof Error ? e.message : 'Failed to load audio');
    }).finally(() => setLoading(false));
  }, [rpc, path]);

  // Keyboard shortcuts
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); playerRef.current?.toggle(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); const t = (playerRef.current?.getCurrentTime() || 0) - 5; playerRef.current?.seek(Math.max(0, t)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); const t = (playerRef.current?.getCurrentTime() || 0) + 5; playerRef.current?.seek(t); }
      else if (e.key === 'Escape') onBack();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onBack]);

  const handleSeek = useCallback((timeSec: number) => {
    playerRef.current?.seek(timeSec);
  }, []);

  const handleWaveZoom = useCallback((pct1: number, pct2: number) => {
    if (!settings) return;
    if (pct1 === 0 && pct2 === 1) {
      // Reset
      setSettings(s => s ? { ...s, minTime: 0, maxTime: audioBuffer?.duration || s.maxTime } : s);
    } else {
      const range = settings.maxTime - settings.minTime;
      setSettings(s => s ? { ...s, minTime: s.minTime + pct1 * range, maxTime: s.minTime + pct2 * range } : s);
    }
  }, [settings, audioBuffer]);

  const handleSpecZoom = handleWaveZoom; // Same logic for time axis zoom

  const handleCut = useCallback(() => {
    if (!audioBuffer || !settings) return;
    const sr = audioBuffer.sampleRate;
    const startIdx = Math.floor(settings.minTime * sr);
    const endIdx = Math.floor(settings.maxTime * sr);
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      channels.push(audioBuffer.getChannelData(ch).slice(startIdx, endIdx));
    }
    const wavBuf = encodeWav(channels, sr);
    const blob = new Blob([wavBuf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    a.download = `cut_${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}_${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}${now.getSeconds().toString().padStart(2,'0')}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }, [audioBuffer, settings]);

  return (
    <div className="h5v-overlay-inner" ref={containerRef} tabIndex={-1} style={{ outline: 'none' }}>
      {/* Header */}
      <div className="h5v-panel-header">
        <button className="h5v-back-btn" onClick={onBack}>← Back</button>
        <span style={{ fontSize: 16, color: 'var(--vscode-progressBar-background, #4ec9b0)' }}>♪</span>
        <span className="h5v-panel-title">{name}</span>
        {detection && <span className="h5v-format-badge">{detection.label}</span>}
        <span className="h5v-panel-path">{path}</span>
      </div>

      {detection?.mismatchWarning && <div className="h5v-mismatch-warning">⚠ {detection.mismatchWarning}</div>}
      {error && <div className="h5v-panel-error">{error}</div>}
      {loading && <div className="h5v-panel-loading"><div className="h5v-spinner" /><span>Loading audio...</span></div>}

      {audioBuffer && settings && !loading && (
        <>
          {/* Player controls */}
          <AudioPlayer
            audioBuffer={audioBuffer}
            playheadRefs={playheadRefs.current}
            ref={playerRef}
            hpfEnabled={hpfEnabled}
            hpfFrequency={hpfFreq}
            lpfEnabled={lpfEnabled}
            lpfFrequency={lpfFreq}
          />

          {/* Settings tab bar */}
          <div className="h5v-settings-tabs">
            <span className="h5v-settings-label">Settings</span>
            {(['hide', 'player', 'analyze', 'cut'] as const).map(tab => (
              <button
                key={tab}
                className={`h5v-settings-tab ${settingsTab === tab ? 'active' : ''}`}
                onClick={() => setSettingsTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Settings content */}
          {settingsTab === 'player' && (
            <div className="h5v-settings-content">
              <h4>Filters</h4>
              <label className="h5v-wrap-label">
                <input type="checkbox" checked={hpfEnabled} onChange={e => setHpfEnabled(e.target.checked)} />
                High-pass: <input type="number" min={10} max={audioBuffer.sampleRate / 2} step={10} value={hpfFreq} onChange={e => setHpfFreq(Number(e.target.value))} className="h5v-num-input" /> Hz
              </label>
              <label className="h5v-wrap-label">
                <input type="checkbox" checked={lpfEnabled} onChange={e => setLpfEnabled(e.target.checked)} />
                Low-pass: <input type="number" min={10} max={audioBuffer.sampleRate / 2} step={10} value={lpfFreq} onChange={e => setLpfFreq(Number(e.target.value))} className="h5v-num-input" /> Hz
              </label>
            </div>
          )}

          {settingsTab === 'analyze' && (
            <div className="h5v-settings-content">
              <h4>Time Range</h4>
              <label className="h5v-wrap-label">
                <input type="number" step={0.1} value={settings.minTime.toFixed(1)} onChange={e => setSettings(s => s ? { ...s, minTime: Number(e.target.value) } : s)} className="h5v-num-input" />s ~
                <input type="number" step={0.1} value={settings.maxTime.toFixed(1)} onChange={e => setSettings(s => s ? { ...s, maxTime: Number(e.target.value) } : s)} className="h5v-num-input" />s
                <button className="h5v-tool-btn" onClick={() => setSettings(s => s ? { ...s, minTime: 0, maxTime: audioBuffer.duration } : s)}>Reset</button>
              </label>

              <h4>Waveform</h4>
              <label className="h5v-wrap-label">
                <input type="checkbox" checked={settings.waveformVisible} onChange={e => setSettings(s => s ? { ...s, waveformVisible: e.target.checked } : s)} /> Visible
              </label>

              <h4>Spectrogram</h4>
              <label className="h5v-wrap-label">
                <input type="checkbox" checked={settings.spectrogramVisible} onChange={e => setSettings(s => s ? { ...s, spectrogramVisible: e.target.checked } : s)} /> Visible
              </label>
              <label className="h5v-wrap-label">
                Window size:
                <select value={settings.windowSize} onChange={e => setSettings(s => s ? { ...s, windowSize: Number(e.target.value) } : s)} className="h5v-select">
                  {WINDOW_SIZES.map(ws => <option key={ws} value={ws}>{ws}</option>)}
                </select>
              </label>
              <label className="h5v-wrap-label">
                Frequency scale:
                <select value={settings.frequencyScale} onChange={e => setSettings(s => s ? { ...s, frequencyScale: e.target.value as FrequencyScale } : s)} className="h5v-select">
                  <option value="linear">Linear</option>
                  <option value="log">Log</option>
                  <option value="mel">Mel</option>
                </select>
                {settings.frequencyScale === 'mel' && (
                  <>Mel filters: <input type="number" min={20} max={200} step={10} value={settings.melFilterNum} onChange={e => setSettings(s => s ? { ...s, melFilterNum: Number(e.target.value) } : s)} className="h5v-num-input" /></>
                )}
              </label>
              <label className="h5v-wrap-label">
                Freq range:
                <input type="number" step={100} value={settings.minFrequency} onChange={e => setSettings(s => s ? { ...s, minFrequency: Number(e.target.value) } : s)} className="h5v-num-input" />Hz ~
                <input type="number" step={100} value={settings.maxFrequency} onChange={e => setSettings(s => s ? { ...s, maxFrequency: Number(e.target.value) } : s)} className="h5v-num-input" />Hz
              </label>
              <label className="h5v-wrap-label">
                Amplitude range:
                <input type="number" step={10} value={settings.amplitudeRange} onChange={e => setSettings(s => s ? { ...s, amplitudeRange: Number(e.target.value) } : s)} className="h5v-num-input" />dB ~ 0 dB
              </label>
            </div>
          )}

          {settingsTab === 'cut' && (
            <div className="h5v-settings-content">
              <p>Cut the currently selected time range ({settings.minTime.toFixed(2)}s ~ {settings.maxTime.toFixed(2)}s) and save as WAV.</p>
              <button className="h5v-tool-btn" onClick={handleCut}>Export WAV</button>
            </div>
          )}

          {/* Info table */}
          <div className="h5v-info-table">
            <table>
              <tbody>
                <tr><th>Channels</th><td>{audioBuffer.numberOfChannels} ch {audioBuffer.numberOfChannels === 1 ? '(mono)' : audioBuffer.numberOfChannels === 2 ? '(stereo)' : ''}</td></tr>
                <tr><th>Sample Rate</th><td>{audioBuffer.sampleRate.toLocaleString()} Hz</td></tr>
                <tr><th>Duration</th><td>{audioBuffer.duration.toFixed(3)} s</td></tr>
                <tr><th>Samples</th><td>{audioBuffer.length.toLocaleString()}</td></tr>
              </tbody>
            </table>
          </div>

          {/* Visualizations */}
          <div className="h5v-panel-body">
            {settings.waveformVisible && (
              <Waveform
                audioBuffer={audioBuffer}
                settings={settings}
                playheadRef={wavePlayheadRef}
                onSeek={handleSeek}
                onDragZoom={handleWaveZoom}
              />
            )}
            {settings.spectrogramVisible && (
              <Spectrogram
                audioBuffer={audioBuffer}
                settings={settings}
                playheadRef={specPlayheadRef}
                onSeek={handleSeek}
                onDragZoom={handleSpecZoom}
              />
            )}
          </div>

          {/* Shortcuts help */}
          <div className="h5v-shortcuts-bar">
            Space: play/pause · ←/→: ±5s · Click: seek · Drag: zoom · Right-click: reset zoom · Esc: back
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Canvas spectrogram with CSS playhead and click-to-seek.
 * FFT adapted from vscode-audio-preview (MIT).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { computeSpectrogram, dbToColor, type SpectrogramOptions } from './audio-utils';

interface Props {
  audioBuffer: AudioBuffer | null;
  currentTime?: number;
  height?: number;
  channel?: number;
  options?: SpectrogramOptions;
  onSeek?: (time: number) => void;
}

const CANVAS_W = 1800;

export default function Spectrogram({
  audioBuffer, currentTime = 0, height = 280, channel = 0, options = {}, onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [computing, setComputing] = useState(false);
  const specRef = useRef<ReturnType<typeof computeSpectrogram> | null>(null);

  const minDb = options.minDb ?? -90;
  const maxDb = options.maxDb ?? 0;

  // Compute spectrogram (once per buffer/channel)
  useEffect(() => {
    if (!audioBuffer) return;
    setComputing(true);

    requestAnimationFrame(() => {
      let samples: Float32Array;
      if (channel === -1) {
        const len = audioBuffer.length;
        samples = new Float32Array(len);
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
          const d = audioBuffer.getChannelData(ch);
          for (let i = 0; i < len; i++) samples[i] += d[i];
        }
        const scale = 1 / audioBuffer.numberOfChannels;
        for (let i = 0; i < len; i++) samples[i] *= scale;
      } else {
        samples = audioBuffer.getChannelData(Math.min(channel, audioBuffer.numberOfChannels - 1));
      }

      specRef.current = computeSpectrogram(samples, audioBuffer.sampleRate, options);
      setComputing(false);
    });
  }, [audioBuffer, channel, options.windowSize, options.hopSize]);

  // Render spectrogram to canvas (once, no playhead redraw)
  useEffect(() => {
    const canvas = canvasRef.current;
    const spec = specRef.current;
    if (!canvas || !spec || computing) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    canvas.width = CANVAS_W;
    canvas.height = height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_W, height);

    const { data, numFrames, numBins } = spec;
    const rw = Math.max(1, CANVAS_W / numFrames);
    const rh = Math.max(1, height / numBins);

    for (let f = 0; f < numFrames; f++) {
      const x = (f / numFrames) * CANVAS_W;
      const frame = data[f];
      for (let b = 0; b < numBins; b++) {
        const db = frame[b];
        if (db < minDb) continue;
        const [r, g, bl] = dbToColor(db, minDb, maxDb);
        const y = height - ((b + 1) / numBins) * height;
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(x, y, rw + 0.5, rh + 0.5);
      }
    }

    // Frequency labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    const maxFreq = spec.sampleRate / 2;
    for (const freq of [100, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f < maxFreq)) {
      const y = height - (freq / maxFreq) * height;
      if (y < 12 || y > height - 4) continue;
      ctx.fillText(`${freq >= 1000 ? `${freq / 1000}k` : freq} Hz`, 4, y);
      ctx.strokeStyle = 'rgba(100,100,100,0.2)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }
  }, [computing, height, minDb, maxDb]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!audioBuffer || !containerRef.current || !onSeek) return;
    const rect = containerRef.current.getBoundingClientRect();
    onSeek((e.clientX - rect.left) / rect.width * audioBuffer.duration);
  }, [audioBuffer, onSeek]);

  if (!audioBuffer) return null;

  const pct = audioBuffer.duration > 0 ? (currentTime / audioBuffer.duration) * 100 : 0;

  return (
    <div className="h5v-viz-container" ref={containerRef} onClick={handleClick}>
      {computing && <div className="h5v-panel-loading">Computing spectrogram...</div>}
      <canvas ref={canvasRef} style={{ height, display: computing ? 'none' : 'block' }} />
      {!computing && <div className="h5v-playhead" style={{ left: `${pct}%` }} />}
    </div>
  );
}

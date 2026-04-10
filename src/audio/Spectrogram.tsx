/**
 * Canvas-based spectrogram renderer.
 * FFT computation and color mapping adapted from vscode-audio-preview (MIT).
 */

import { useEffect, useRef, useState } from 'react';
import { computeSpectrogram, dbToColor, type SpectrogramOptions } from './audio-utils';

interface Props {
  audioBuffer: AudioBuffer | null;
  currentTime?: number;
  height?: number;
  /** Which channel to analyze (0-based). -1 = mix all channels. */
  channel?: number;
  options?: SpectrogramOptions;
}

const CANVAS_WIDTH = 1800;

export default function Spectrogram({
  audioBuffer,
  currentTime = 0,
  height = 300,
  channel = 0,
  options = {},
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [computing, setComputing] = useState(false);
  const spectrogramRef = useRef<ReturnType<typeof computeSpectrogram> | null>(null);

  const minDb = options.minDb ?? -90;
  const maxDb = options.maxDb ?? 0;

  useEffect(() => {
    if (!audioBuffer) return;

    setComputing(true);

    // Use requestAnimationFrame to avoid blocking UI
    requestAnimationFrame(() => {
      let samples: Float32Array;
      if (channel === -1) {
        // Mix all channels
        const length = audioBuffer.length;
        samples = new Float32Array(length);
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
          const chData = audioBuffer.getChannelData(ch);
          for (let i = 0; i < length; i++) {
            samples[i] += chData[i];
          }
        }
        const scale = 1 / audioBuffer.numberOfChannels;
        for (let i = 0; i < length; i++) samples[i] *= scale;
      } else {
        const ch = Math.min(channel, audioBuffer.numberOfChannels - 1);
        samples = audioBuffer.getChannelData(ch);
      }

      const result = computeSpectrogram(samples, audioBuffer.sampleRate, options);
      spectrogramRef.current = result;
      setComputing(false);
    });
  }, [audioBuffer, channel, options.windowSize, options.hopSize]);

  // Render spectrogram to canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const spec = spectrogramRef.current;
    if (!canvas || !spec || computing) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    canvas.width = CANVAS_WIDTH;
    canvas.height = height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, height);

    const { data, numFrames, numBins } = spec;
    const rectWidth = Math.max(1, CANVAS_WIDTH / numFrames);
    const rectHeight = Math.max(1, height / numBins);

    for (let f = 0; f < numFrames; f++) {
      const x = (f / numFrames) * CANVAS_WIDTH;
      const frame = data[f];
      for (let b = 0; b < numBins; b++) {
        const db = frame[b];
        if (db < minDb) continue; // Skip very quiet bins

        const [r, g, bl] = dbToColor(db, minDb, maxDb);
        // Frequency axis: low freq at bottom, high at top
        const y = height - ((b + 1) / numBins) * height;
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(x, y, rectWidth + 0.5, rectHeight + 0.5);
      }
    }

    // Axis labels
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    const maxFreq = spec.sampleRate / 2;
    const freqSteps = [100, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f < maxFreq);
    for (const freq of freqSteps) {
      const y = height - (freq / maxFreq) * height;
      if (y < 12 || y > height - 4) continue;
      ctx.fillText(`${freq >= 1000 ? `${freq / 1000}k` : freq} Hz`, 4, y);
      ctx.strokeStyle = 'rgba(100,100,100,0.2)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_WIDTH, y);
      ctx.stroke();
    }

    // Playback position
    if (currentTime > 0 && audioBuffer && audioBuffer.duration > 0) {
      const x = (currentTime / audioBuffer.duration) * CANVAS_WIDTH;
      ctx.strokeStyle = '#4ec9b0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }, [computing, height, minDb, maxDb, currentTime, audioBuffer]);

  if (!audioBuffer) return null;

  return (
    <div style={styles.wrapper}>
      {computing && <div style={styles.computing}>Computing spectrogram...</div>}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, display: computing ? 'none' : 'block' }}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    background: '#000',
    position: 'relative',
  },
  computing: {
    padding: '20px',
    color: '#888',
    fontSize: '12px',
    textAlign: 'center',
  },
};

/**
 * Canvas-based waveform renderer.
 * Adapted from vscode-audio-preview waveFormComponent (MIT).
 */

import { useEffect, useRef } from 'react';
import { downsampleForDisplay } from './audio-utils';

interface Props {
  audioBuffer: AudioBuffer | null;
  currentTime?: number;
  height?: number;
}

const CANVAS_WIDTH = 1200;
const MAX_POINTS = 200_000;

export default function Waveform({ audioBuffer, currentTime = 0, height = 150 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const numChannels = audioBuffer.numberOfChannels;
    const totalHeight = height * numChannels;
    canvas.width = CANVAS_WIDTH;
    canvas.height = totalHeight;

    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, CANVAS_WIDTH, totalHeight);

    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      const yOffset = ch * height;
      const { samples } = downsampleForDisplay(data, MAX_POINTS);

      // Find amplitude range
      let minVal = 0, maxVal = 0;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i] < minVal) minVal = samples[i];
        if (samples[i] > maxVal) maxVal = samples[i];
      }
      const range = Math.max(maxVal - minVal, 1e-10);

      // Draw waveform
      ctx.strokeStyle = 'rgb(160, 60, 200)';
      ctx.lineWidth = 1;

      if (samples.length > CANVAS_WIDTH * 5) {
        // Dense mode: plot dots
        ctx.fillStyle = 'rgb(160, 60, 200)';
        for (let i = 0; i < samples.length; i++) {
          const x = (i / samples.length) * CANVAS_WIDTH;
          const d = (samples[i] - minVal) / range;
          const y = yOffset + height * (1 - d);
          ctx.fillRect(x, y, 1, 1);
        }
      } else {
        // Sparse mode: line path
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
          const x = (i / samples.length) * CANVAS_WIDTH;
          const d = (samples[i] - minVal) / range;
          const y = yOffset + height * (1 - d);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Zero line
      const zeroY = yOffset + height * (1 - (0 - minVal) / range);
      ctx.strokeStyle = 'rgba(100, 100, 100, 0.3)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(CANVAS_WIDTH, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Channel label
      ctx.fillStyle = '#888';
      ctx.font = '11px monospace';
      ctx.fillText(numChannels === 1 ? 'mono' : `ch${ch + 1}`, 4, yOffset + 14);
    }

    // Playback position bar
    if (currentTime > 0 && audioBuffer.duration > 0) {
      const x = (currentTime / audioBuffer.duration) * CANVAS_WIDTH;
      ctx.strokeStyle = '#4ec9b0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, totalHeight);
      ctx.stroke();
    }
  }, [audioBuffer, currentTime, height]);

  if (!audioBuffer) return null;

  const numChannels = audioBuffer.numberOfChannels;

  return (
    <div style={styles.wrapper}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: height * numChannels }}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    background: '#1e1e1e',
    borderBottom: '1px solid #3c3c3c',
  },
};

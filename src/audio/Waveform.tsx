/**
 * Canvas waveform with CSS playhead (no per-frame redraw) and click-to-seek.
 * Adapted from vscode-audio-preview waveFormComponent (MIT).
 */

import { useCallback, useEffect, useRef } from 'react';
import { downsampleForDisplay } from './audio-utils';

interface Props {
  audioBuffer: AudioBuffer | null;
  currentTime?: number;
  height?: number;
  onSeek?: (time: number) => void;
}

const CANVAS_W = 1200;
const MAX_PTS = 200_000;

export default function Waveform({ audioBuffer, currentTime = 0, height = 140, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Draw waveform once (static — playhead is a separate CSS element)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const nch = audioBuffer.numberOfChannels;
    const totalH = height * nch;
    canvas.width = CANVAS_W;
    canvas.height = totalH;

    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, CANVAS_W, totalH);

    for (let ch = 0; ch < nch; ch++) {
      const data = audioBuffer.getChannelData(ch);
      const yOff = ch * height;
      const { samples } = downsampleForDisplay(data, MAX_PTS);

      let minV = 0, maxV = 0;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i] < minV) minV = samples[i];
        if (samples[i] > maxV) maxV = samples[i];
      }
      const range = Math.max(maxV - minV, 1e-10);

      ctx.strokeStyle = 'rgb(160,60,200)';
      ctx.fillStyle = 'rgb(160,60,200)';
      ctx.lineWidth = 1;

      if (samples.length > CANVAS_W * 5) {
        for (let i = 0; i < samples.length; i++) {
          const x = (i / samples.length) * CANVAS_W;
          const y = yOff + height * (1 - (samples[i] - minV) / range);
          ctx.fillRect(x, y, 1, 1);
        }
      } else {
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
          const x = (i / samples.length) * CANVAS_W;
          const y = yOff + height * (1 - (samples[i] - minV) / range);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Zero line
      const zeroY = yOff + height * (1 - (0 - minV) / range);
      ctx.strokeStyle = 'rgba(128,128,128,0.25)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(CANVAS_W, zeroY); ctx.stroke();
      ctx.setLineDash([]);

      // Channel label
      ctx.fillStyle = '#888';
      ctx.font = '11px monospace';
      ctx.fillText(nch === 1 ? 'mono' : `ch${ch + 1}`, 4, yOff + 14);
    }
  }, [audioBuffer, height]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!audioBuffer || !containerRef.current || !onSeek) return;
    const rect = containerRef.current.getBoundingClientRect();
    onSeek((e.clientX - rect.left) / rect.width * audioBuffer.duration);
  }, [audioBuffer, onSeek]);

  if (!audioBuffer) return null;

  const pct = audioBuffer.duration > 0 ? (currentTime / audioBuffer.duration) * 100 : 0;

  return (
    <div className="h5v-viz-container" ref={containerRef} onClick={handleClick}>
      <canvas ref={canvasRef} style={{ height: height * audioBuffer.numberOfChannels }} />
      <div className="h5v-playhead" style={{ left: `${pct}%` }} />
    </div>
  );
}

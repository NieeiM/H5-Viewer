/**
 * Canvas waveform with axis grids, channel labels, CSS playhead, click-to-seek.
 * Adapted from vscode-audio-preview waveFormComponent (MIT).
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  WAVEFORM_CANVAS_WIDTH as CW, WAVEFORM_CANVAS_HEIGHT as CH,
  MIN_DATA_POINTS_PER_PIXEL, downsampleForDisplay, roundToNearestNiceNumber,
  type AnalysisSettings,
} from './audio-utils';

interface Props {
  audioBuffer: AudioBuffer | null;
  settings: AnalysisSettings;
  playheadRef: React.RefObject<HTMLDivElement | null>;
  onSeek?: (timeSec: number) => void;
  onDragZoom?: (startPct: number, endPct: number) => void;
}

const WAVE_COLOR = 'rgb(160,60,200)';
const GRID_COLOR = 'rgb(180,120,20)';
const AXIS_COLOR = 'rgb(245,130,32)';
const LABEL_COLOR = 'rgb(220,220,220)';

export default function Waveform({ audioBuffer, settings, playheadRef, onSeek, onDragZoom }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const axisCanvasRef = useRef<HTMLCanvasElement>(null);

  const { minTime, maxTime, minAmplitude, maxAmplitude } = settings;

  // Draw waveform + axis
  useEffect(() => {
    const canvas = canvasRef.current;
    const axisCanvas = axisCanvasRef.current;
    if (!canvas || !axisCanvas || !audioBuffer) return;

    const nch = audioBuffer.numberOfChannels;
    const chHeight = CH;
    const totalH = chHeight * nch;
    const width = CW;

    canvas.width = width;
    canvas.height = totalH;
    axisCanvas.width = width;
    axisCanvas.height = totalH;

    const ctx = canvas.getContext('2d', { alpha: false })!;
    const axCtx = axisCanvas.getContext('2d')!;

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, totalH);
    axCtx.clearRect(0, 0, width, totalH);

    const sr = audioBuffer.sampleRate;
    const startIdx = Math.floor(minTime * sr);
    const endIdx = Math.floor(maxTime * sr);
    const timeRange = maxTime - minTime;
    const ampRange = maxAmplitude - minAmplitude;

    for (let ch = 0; ch < nch; ch++) {
      const data = audioBuffer.getChannelData(ch);
      const yOff = ch * chHeight;

      // Downsample
      const { samples } = downsampleForDisplay(data, startIdx, endIdx, 200000);

      // Draw waveform
      ctx.fillStyle = WAVE_COLOR;
      ctx.strokeStyle = WAVE_COLOR;
      ctx.lineWidth = 1;

      if (samples.length > width * MIN_DATA_POINTS_PER_PIXEL) {
        // Pixel mode
        for (let i = 0; i < samples.length; i++) {
          const x = (i / samples.length) * width;
          const d = (samples[i] - minAmplitude) / ampRange;
          const y = yOff + chHeight * (1 - d);
          ctx.fillRect(x, y, 1, 1);
        }
      } else {
        // Line mode
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
          const x = (i / samples.length) * width;
          const d = (samples[i] - minAmplitude) / ampRange;
          const y = yOff + chHeight * (1 - d);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // --- Axis on overlay canvas ---

      // Time axis (horizontal gridlines)
      if (timeRange > 0) {
        const [niceTime] = roundToNearestNiceNumber(timeRange / 8);
        if (niceTime > 0) {
          const startTick = Math.ceil(minTime / niceTime) * niceTime;
          axCtx.fillStyle = AXIS_COLOR;
          axCtx.strokeStyle = GRID_COLOR;
          axCtx.font = '11px Arial';
          axCtx.setLineDash([2, 2]);
          for (let t = startTick; t <= maxTime; t += niceTime) {
            const x = ((t - minTime) / timeRange) * width;
            if (x < width * 0.05 || x > width * 0.95) continue;
            axCtx.beginPath();
            axCtx.moveTo(x, yOff);
            axCtx.lineTo(x, yOff + chHeight);
            axCtx.stroke();
            axCtx.fillText(`${t.toFixed(2)}s`, x + 2, yOff + chHeight - 3);
          }
          axCtx.setLineDash([]);
        }
      }

      // Amplitude axis (vertical gridlines)
      if (ampRange > 0) {
        const [niceAmp] = roundToNearestNiceNumber(ampRange / 5);
        if (niceAmp > 0) {
          const startAmp = Math.ceil(minAmplitude / niceAmp) * niceAmp;
          axCtx.fillStyle = AXIS_COLOR;
          axCtx.strokeStyle = GRID_COLOR;
          axCtx.font = '10px Arial';
          axCtx.setLineDash([2, 2]);
          for (let a = startAmp; a <= maxAmplitude; a += niceAmp) {
            const y = yOff + chHeight * (1 - (a - minAmplitude) / ampRange);
            if (y < yOff + 5 || y > yOff + chHeight - 5) continue;
            axCtx.beginPath();
            axCtx.moveTo(0, y);
            axCtx.lineTo(width, y);
            axCtx.stroke();
            axCtx.fillText(a.toFixed(2), 3, y - 2);
          }
          axCtx.setLineDash([]);
        }
      }

      // Channel label
      axCtx.fillStyle = LABEL_COLOR;
      axCtx.font = '12px Arial';
      const label = nch === 1 ? 'mono' : nch === 2 ? (ch === 0 ? 'Lch' : 'Rch') : `ch${ch + 1}`;
      axCtx.fillText(label, width - 40, yOff + 16);
    }
  }, [audioBuffer, minTime, maxTime, minAmplitude, maxAmplitude]);

  // Click to seek
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!audioBuffer || !containerRef.current || !onSeek) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const timeSec = minTime + pct * (maxTime - minTime);
    onSeek(timeSec);
  }, [audioBuffer, onSeek, minTime, maxTime]);

  // Drag to zoom
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const selRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragStart.current || !selRef.current || !containerRef.current) return;
    const dx = Math.abs(e.clientX - dragStart.current.x);
    const dy = Math.abs(e.clientY - dragStart.current.y);
    if (dx < 3 && dy < 3) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x1 = Math.min(dragStart.current.x, e.clientX) - rect.left;
    const x2 = Math.max(dragStart.current.x, e.clientX) - rect.left;
    const sel = selRef.current;
    sel.style.display = 'block';
    sel.style.left = `${(x1 / rect.width) * 100}%`;
    sel.style.width = `${((x2 - x1) / rect.width) * 100}%`;
    sel.style.top = '0';
    sel.style.height = '100%';
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!dragStart.current || !containerRef.current) return;
    const dx = Math.abs(e.clientX - dragStart.current.x);
    if (selRef.current) selRef.current.style.display = 'none';

    if (dx < 3) {
      // Click — seek
      dragStart.current = null;
      return;
    }

    // Drag — zoom
    const rect = containerRef.current.getBoundingClientRect();
    const pct1 = Math.max(0, Math.min(1, (Math.min(dragStart.current.x, e.clientX) - rect.left) / rect.width));
    const pct2 = Math.max(0, Math.min(1, (Math.max(dragStart.current.x, e.clientX) - rect.left) / rect.width));
    dragStart.current = null;

    if (onDragZoom && pct2 - pct1 > 0.01) {
      onDragZoom(pct1, pct2);
    }
  }, [onDragZoom]);

  // Right-click to reset zoom
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (onDragZoom) onDragZoom(0, 1); // Signal full reset
  }, [onDragZoom]);

  if (!audioBuffer) return null;

  const nch = audioBuffer.numberOfChannels;
  const totalH = CH * nch;

  return (
    <div
      className="h5v-viz-container"
      ref={containerRef}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      <canvas ref={canvasRef} style={{ height: totalH }} />
      <canvas ref={axisCanvasRef} className="h5v-axis-canvas" style={{ height: totalH }} />
      <div className="h5v-playhead" ref={playheadRef as React.RefObject<HTMLDivElement>} />
      <div className="h5v-selection" ref={selRef} />
    </div>
  );
}

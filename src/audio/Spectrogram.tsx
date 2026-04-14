/**
 * Canvas spectrogram with Linear/Log/Mel frequency scales, axis grids,
 * CSS playhead, click-to-seek, drag-to-zoom.
 * Adapted from vscode-audio-preview spectrogramComponent (MIT).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SPECTROGRAM_CANVAS_WIDTH as CW, SPECTROGRAM_CANVAS_HEIGHT as CH,
  computeSpectrogram, computeMelSpectrogram, spectrogramColor,
  roundToNearestNiceNumber,
  type AnalysisSettings, type SpectrogramResult,
} from './audio-utils';

const AXIS_COLOR = 'rgb(245,130,32)';
const GRID_COLOR = 'rgba(180,120,20,0.4)';
const LABEL_COLOR = 'rgb(220,220,220)';
const EPSILON = 1e-10;

interface Props {
  audioBuffer: AudioBuffer | null;
  settings: AnalysisSettings;
  channel?: number; // -1 = mix, 0+ = specific channel
  playheadRef: React.RefObject<HTMLDivElement | null>;
  onSeek?: (timeSec: number) => void;
  onDragZoom?: (startPct: number, endPct: number) => void;
}

export default function Spectrogram({
  audioBuffer, settings, channel = 0, playheadRef, onSeek, onDragZoom,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const axisCanvasRef = useRef<HTMLCanvasElement>(null);
  const [computing, setComputing] = useState(false);
  const specRef = useRef<SpectrogramResult | null>(null);

  const { minTime, maxTime, minFrequency, maxFrequency, amplitudeRange, frequencyScale } = settings;

  // Compute spectrogram
  useEffect(() => {
    if (!audioBuffer || !settings.spectrogramVisible) return;
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

      if (frequencyScale === 'mel') {
        specRef.current = computeMelSpectrogram(samples, audioBuffer.sampleRate, settings);
      } else {
        specRef.current = computeSpectrogram(samples, audioBuffer.sampleRate, settings);
      }
      setComputing(false);
    });
  }, [audioBuffer, channel, settings.windowSize, minTime, maxTime, minFrequency, maxFrequency, frequencyScale, settings.melFilterNum, settings.spectrogramVisible]);

  // Render to canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const axisCanvas = axisCanvasRef.current;
    const spec = specRef.current;
    if (!canvas || !axisCanvas || !spec || computing || !audioBuffer) return;

    const width = CW;
    const height = CH;
    canvas.width = width;
    canvas.height = height;
    axisCanvas.width = width;
    axisCanvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: false })!;
    const axCtx = axisCanvas.getContext('2d')!;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    axCtx.clearRect(0, 0, width, height);

    const { data, numFrames, numBins } = spec;
    const timeRange = maxTime - minTime;
    const sr = audioBuffer.sampleRate;
    const wholeSampleNum = Math.floor(timeRange * sr);

    // Draw spectrogram pixels
    for (let f = 0; f < numFrames; f++) {
      const x = (f / numFrames) * width;
      const rw = Math.max(1, width / numFrames);
      const frame = data[f];

      for (let b = 0; b < numBins; b++) {
        const db = frame[b];
        if (db < amplitudeRange) continue;

        const [r, g, bl] = spectrogramColor(db, amplitudeRange);

        let y: number, rh: number;

        if (frequencyScale === 'log') {
          const minF = Math.max(minFrequency, 1);
          const logMin = Math.log10(minF + EPSILON);
          const logMax = Math.log10(maxFrequency + EPSILON);
          const logRange = logMax - logMin;
          const freq = minF + (b / numBins) * (maxFrequency - minF);
          const freqNext = minF + ((b + 1) / numBins) * (maxFrequency - minF);
          const logFreq = Math.log10(freq + EPSILON);
          const logFreqNext = Math.log10(freqNext + EPSILON);
          y = height - ((logFreq - logMin) / logRange) * height;
          rh = Math.max(1, ((logFreqNext - logFreq) / logRange) * height);
          y -= rh;
        } else if (frequencyScale === 'mel') {
          rh = Math.max(1, height / numBins);
          y = height - (b + 1) * rh;
        } else {
          // Linear
          rh = Math.max(1, height / numBins);
          y = height - (b + 1) * rh;
        }

        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(x, y, rw + 0.5, rh + 0.5);
      }
    }

    // --- Axis overlay ---

    // Time axis
    if (timeRange > 0) {
      const [niceTime] = roundToNearestNiceNumber(timeRange / 10);
      if (niceTime > 0) {
        const startTick = Math.ceil(minTime / niceTime) * niceTime;
        axCtx.fillStyle = AXIS_COLOR;
        axCtx.strokeStyle = GRID_COLOR;
        axCtx.font = '12px Arial';
        axCtx.setLineDash([2, 2]);
        for (let t = startTick; t <= maxTime; t += niceTime) {
          const x = ((t - minTime) / timeRange) * width;
          if (x < width * 0.03 || x > width * 0.97) continue;
          axCtx.beginPath();
          axCtx.moveTo(x, 0);
          axCtx.lineTo(x, height);
          axCtx.stroke();
          axCtx.fillText(`${t.toFixed(2)}s`, x + 2, height - 4);
        }
        axCtx.setLineDash([]);
      }
    }

    // Frequency axis
    const maxFreq = maxFrequency;
    const minFreq = Math.max(minFrequency, frequencyScale === 'log' ? 1 : 0);
    const numAxes = 10;
    axCtx.fillStyle = AXIS_COLOR;
    axCtx.strokeStyle = GRID_COLOR;
    axCtx.font = '11px Arial';
    axCtx.setLineDash([2, 2]);

    if (frequencyScale === 'log') {
      const logMin = Math.log10(minFreq + EPSILON);
      const logMax = Math.log10(maxFreq + EPSILON);
      const logRange = logMax - logMin;
      for (let i = 1; i <= numAxes; i++) {
        const logF = logMin + (i / (numAxes + 1)) * logRange;
        const freq = Math.pow(10, logF);
        const y = height - ((logF - logMin) / logRange) * height;
        axCtx.beginPath(); axCtx.moveTo(0, y); axCtx.lineTo(width, y); axCtx.stroke();
        axCtx.fillText(freq >= 1000 ? `${(freq / 1000).toFixed(1)}kHz` : `${Math.round(freq)}Hz`, 3, y - 2);
      }
    } else if (frequencyScale === 'mel') {
      // Mel: use Hz labels at key frequencies
      for (const freq of [100, 200, 500, 1000, 2000, 4000, 8000, 16000]) {
        if (freq < minFreq || freq > maxFreq) continue;
        // Approximate position in mel space
        const melMin = 2595 * Math.log10(1 + minFreq / 700);
        const melMax = 2595 * Math.log10(1 + maxFreq / 700);
        const melF = 2595 * Math.log10(1 + freq / 700);
        const y = height - ((melF - melMin) / (melMax - melMin)) * height;
        axCtx.beginPath(); axCtx.moveTo(0, y); axCtx.lineTo(width, y); axCtx.stroke();
        axCtx.fillText(freq >= 1000 ? `${freq / 1000}kHz` : `${freq}Hz`, 3, y - 2);
      }
    } else {
      // Linear
      const [niceFreq] = roundToNearestNiceNumber((maxFreq - minFreq) / numAxes);
      if (niceFreq > 0) {
        const startF = Math.ceil(minFreq / niceFreq) * niceFreq;
        for (let f = startF; f <= maxFreq; f += niceFreq) {
          const y = height - ((f - minFreq) / (maxFreq - minFreq)) * height;
          if (y < 10 || y > height - 5) continue;
          axCtx.beginPath(); axCtx.moveTo(0, y); axCtx.lineTo(width, y); axCtx.stroke();
          axCtx.fillText(f >= 1000 ? `${(f / 1000).toFixed(1)}kHz` : `${Math.round(f)}Hz`, 3, y - 2);
        }
      }
    }
    axCtx.setLineDash([]);

    // Channel label
    axCtx.fillStyle = LABEL_COLOR;
    axCtx.font = '12px Arial';
    const nch = audioBuffer.numberOfChannels;
    const chLabel = channel === -1 ? 'mix' : nch === 1 ? 'mono' : nch === 2 ? (channel === 0 ? 'Lch' : 'Rch') : `ch${channel + 1}`;
    axCtx.fillText(chLabel, width - 40, 16);
  }, [computing, audioBuffer, minTime, maxTime, minFrequency, maxFrequency, amplitudeRange, frequencyScale]);

  // Click to seek
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!audioBuffer || !containerRef.current || !onSeek) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    onSeek(minTime + pct * (maxTime - minTime));
  }, [audioBuffer, onSeek, minTime, maxTime]);

  // Drag to zoom (same as Waveform)
  const dragStart = useRef<{ x: number } | null>(null);
  const selRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragStart.current || !selRef.current || !containerRef.current) return;
    const dx = Math.abs(e.clientX - dragStart.current.x);
    if (dx < 3) return;
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
    if (dx < 3) { dragStart.current = null; return; }

    const rect = containerRef.current.getBoundingClientRect();
    const pct1 = Math.max(0, Math.min(1, (Math.min(dragStart.current.x, e.clientX) - rect.left) / rect.width));
    const pct2 = Math.max(0, Math.min(1, (Math.max(dragStart.current.x, e.clientX) - rect.left) / rect.width));
    dragStart.current = null;
    if (onDragZoom && pct2 - pct1 > 0.01) onDragZoom(pct1, pct2);
  }, [onDragZoom]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (onDragZoom) onDragZoom(0, 1);
  }, [onDragZoom]);

  if (!audioBuffer || !settings.spectrogramVisible) return null;

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
      {computing && <div className="h5v-panel-loading">Computing spectrogram...</div>}
      <canvas ref={canvasRef} style={{ height: CH, display: computing ? 'none' : 'block' }} />
      <canvas ref={axisCanvasRef} className="h5v-axis-canvas" style={{ height: CH, display: computing ? 'none' : 'block' }} />
      {!computing && <div className="h5v-playhead" ref={playheadRef as React.RefObject<HTMLDivElement>} />}
      <div className="h5v-selection" ref={selRef} />
    </div>
  );
}

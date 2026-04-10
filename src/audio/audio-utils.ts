/**
 * Audio visualization utilities.
 * FFT computation, color mapping, and waveform helpers.
 *
 * Spectrogram analysis adapted from vscode-audio-preview by sukumo28 (MIT).
 */

import Ooura from 'ooura';

// ---------------------------------------------------------------------------
// Hann window
// ---------------------------------------------------------------------------

export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return window;
}

// ---------------------------------------------------------------------------
// FFT / Spectrogram computation
// ---------------------------------------------------------------------------

export interface SpectrogramOptions {
  windowSize?: number;
  hopSize?: number;
  minFreq?: number;
  maxFreq?: number;
  minDb?: number;
  maxDb?: number;
}

export interface SpectrogramResult {
  /** 2D array [timeFrames][freqBins], values in dB (0 = max) */
  data: Float32Array[];
  /** Number of time frames */
  numFrames: number;
  /** Number of frequency bins */
  numBins: number;
  /** Frequency per bin in Hz */
  freqPerBin: number;
  /** Time per frame in seconds */
  timePerFrame: number;
  /** Sample rate */
  sampleRate: number;
}

export function computeSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  options: SpectrogramOptions = {},
): SpectrogramResult {
  const windowSize = options.windowSize || 1024;
  const minHopSize = Math.max(1, Math.floor(windowSize / 32));
  const autoHopSize = Math.max(minHopSize, Math.floor(windowSize / 4));
  const hopSize = options.hopSize || autoHopSize;

  const window = hannWindow(windowSize);
  const halfSize = Math.floor(windowSize / 2);
  const freqPerBin = sampleRate / windowSize;

  const ooura = new Ooura(windowSize, { type: 'real', radix: 4 });

  const numFrames = Math.max(1, Math.floor((samples.length - windowSize) / hopSize) + 1);
  const frames: Float32Array[] = [];

  let globalMax = 1e-30;

  // First pass: compute power spectrum
  const powerFrames: Float32Array[] = [];
  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;
    const re = new Float64Array(halfSize);
    const im = new Float64Array(halfSize);

    // Apply window and prepare input
    const input = new Float64Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
      const idx = offset + i;
      input[i] = idx < samples.length ? samples[idx] * window[i] : 0;
    }

    // FFT
    ooura.fft(input.buffer, re.buffer, im.buffer);

    // Power spectrum
    const power = new Float32Array(halfSize);
    for (let j = 0; j < halfSize; j++) {
      const p = re[j] * re[j] + im[j] * im[j];
      power[j] = p;
      if (p > globalMax) globalMax = p;
    }
    powerFrames.push(power);
  }

  // Second pass: convert to dB (normalized so peak = 0 dB)
  for (const power of powerFrames) {
    const dbFrame = new Float32Array(halfSize);
    for (let j = 0; j < halfSize; j++) {
      dbFrame[j] = 10 * Math.log10(Math.max(power[j], 1e-30) / globalMax);
    }
    frames.push(dbFrame);
  }

  return {
    data: frames,
    numFrames,
    numBins: halfSize,
    freqPerBin,
    timePerFrame: hopSize / sampleRate,
    sampleRate,
  };
}

// ---------------------------------------------------------------------------
// Spectrogram color map (6-class heat, adapted from vscode-audio-preview)
// ---------------------------------------------------------------------------

export function dbToColor(db: number, minDb: number, maxDb: number): [number, number, number] {
  // Normalize to 0..1 (0 = minDb, 1 = maxDb/0dB)
  const t = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));

  // 6-stop heat map: black → dark blue → purple → red → orange → yellow → white
  if (t < 1 / 6) {
    const s = t * 6;
    return [0, 0, Math.round(s * 125)];
  }
  if (t < 2 / 6) {
    const s = (t - 1 / 6) * 6;
    return [Math.round(s * 125), 0, 125];
  }
  if (t < 3 / 6) {
    const s = (t - 2 / 6) * 6;
    return [125 + Math.round(s * 130), 0, 125];
  }
  if (t < 4 / 6) {
    const s = (t - 3 / 6) * 6;
    return [255, Math.round(s * 125), 125];
  }
  if (t < 5 / 6) {
    const s = (t - 4 / 6) * 6;
    return [255, 125 + Math.round(s * 130), 125];
  }
  const s = (t - 5 / 6) * 6;
  return [255, 255, 125 + Math.round(s * 130)];
}

// ---------------------------------------------------------------------------
// Waveform downsampling
// ---------------------------------------------------------------------------

export function downsampleForDisplay(
  data: Float32Array,
  maxPoints: number,
): { samples: Float32Array; step: number } {
  if (data.length <= maxPoints) {
    return { samples: data, step: 1 };
  }

  const step = Math.ceil(data.length / maxPoints);
  const out = new Float32Array(Math.ceil(data.length / step));
  for (let i = 0, j = 0; i < data.length; i += step, j++) {
    out[j] = data[i];
  }
  return { samples: out, step };
}

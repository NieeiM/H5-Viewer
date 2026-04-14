/**
 * Audio analysis and visualization utilities.
 * Adapted from vscode-audio-preview by sukumo28 (MIT).
 *
 * Includes: FFT, spectrogram (Linear/Log/Mel), color mapping,
 * Mel filter bank, axis helpers, waveform downsampling.
 */

import Ooura from 'ooura';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WINDOW_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
export const DEFAULT_WINDOW_SIZE_INDEX = 2; // 1024
export const WAVEFORM_CANVAS_WIDTH = 1000;
export const WAVEFORM_CANVAS_HEIGHT = 200;
export const SPECTROGRAM_CANVAS_WIDTH = 1800;
export const SPECTROGRAM_CANVAS_HEIGHT = 600;
export const MIN_DATA_POINTS_PER_PIXEL = 5;
export const MAX_DOWNSAMPLE_POINTS = 200_000;

export type FrequencyScale = 'linear' | 'log' | 'mel';

// ---------------------------------------------------------------------------
// Analysis settings
// ---------------------------------------------------------------------------

export interface AnalysisSettings {
  windowSize: number;
  hopSize?: number;
  minTime: number;
  maxTime: number;
  minAmplitude: number;
  maxAmplitude: number;
  minFrequency: number;
  maxFrequency: number;
  amplitudeRange: number; // dB, negative (e.g. -90)
  frequencyScale: FrequencyScale;
  melFilterNum: number;
  waveformVisible: boolean;
  spectrogramVisible: boolean;
}

export function defaultSettings(sampleRate: number, duration: number, samples?: Float32Array): AnalysisSettings {
  let minAmp = -1, maxAmp = 1;
  if (samples) {
    minAmp = 0; maxAmp = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] < minAmp) minAmp = samples[i];
      if (samples[i] > maxAmp) maxAmp = samples[i];
    }
    if (minAmp === maxAmp) { minAmp = -1; maxAmp = 1; }
  }
  return {
    windowSize: 1024,
    minTime: 0,
    maxTime: duration,
    minAmplitude: minAmp,
    maxAmplitude: maxAmp,
    minFrequency: 0,
    maxFrequency: sampleRate / 2,
    amplitudeRange: -90,
    frequencyScale: 'linear',
    melFilterNum: 40,
    waveformVisible: true,
    spectrogramVisible: true,
  };
}

// ---------------------------------------------------------------------------
// Hann window
// ---------------------------------------------------------------------------

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}

// ---------------------------------------------------------------------------
// FFT / Spectrogram
// ---------------------------------------------------------------------------

export interface SpectrogramResult {
  data: Float32Array[];
  numFrames: number;
  numBins: number;
  freqPerBin: number;
  hopSize: number;
  sampleRate: number;
  startIndex: number;
  endIndex: number;
}

export function computeSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  settings: AnalysisSettings,
): SpectrogramResult {
  const { windowSize, minTime, maxTime, minFrequency, maxFrequency } = settings;
  const startIndex = Math.floor(minTime * sampleRate);
  const endIndex = Math.floor(maxTime * sampleRate);
  const wholeSampleNum = endIndex - startIndex;

  // Compute hop size (adapted from vscode-audio-preview)
  const minRectWidth = (2 * windowSize) / 1024;
  const enoughHopSize = Math.trunc((minRectWidth * wholeSampleNum) / SPECTROGRAM_CANVAS_WIDTH);
  const minHopSize = Math.max(1, Math.floor(windowSize / 32));
  const hopSize = settings.hopSize || Math.max(enoughHopSize, minHopSize);

  const halfSize = Math.floor(windowSize / 2);
  const freqPerBin = sampleRate / windowSize;
  const minFreqIdx = Math.max(0, Math.floor(minFrequency / freqPerBin));
  const maxFreqIdx = Math.min(halfSize, Math.ceil(maxFrequency / freqPerBin));
  const numBins = maxFreqIdx - minFreqIdx;

  const win = hannWindow(windowSize);
  const ooura = new Ooura(windowSize, { type: 'real', radix: 4 });

  const frames: Float32Array[] = [];
  let globalMax = 1e-30;

  // First pass: compute power
  const powerFrames: Float32Array[] = [];
  for (let center = startIndex; center < endIndex; center += hopSize) {
    const re = new Float64Array(halfSize);
    const im = new Float64Array(halfSize);
    const input = new Float64Array(windowSize);

    for (let i = 0; i < windowSize; i++) {
      const idx = center - Math.floor(windowSize / 2) + i;
      input[i] = (idx >= 0 && idx < samples.length) ? samples[idx] * win[i] : 0;
    }

    ooura.fft(input.buffer, re.buffer, im.buffer);

    const power = new Float32Array(numBins);
    for (let j = 0; j < numBins; j++) {
      const k = j + minFreqIdx;
      const p = re[k] * re[k] + im[k] * im[k];
      power[j] = p;
      if (p > globalMax) globalMax = p;
    }
    powerFrames.push(power);
  }

  // Second pass: normalize to dB
  for (const power of powerFrames) {
    const dbFrame = new Float32Array(power.length);
    for (let j = 0; j < power.length; j++) {
      dbFrame[j] = 10 * Math.log10(Math.max(power[j], 1e-30) / globalMax);
    }
    frames.push(dbFrame);
  }

  return {
    data: frames,
    numFrames: frames.length,
    numBins,
    freqPerBin,
    hopSize,
    sampleRate,
    startIndex,
    endIndex,
  };
}

// ---------------------------------------------------------------------------
// Mel spectrogram
// ---------------------------------------------------------------------------

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

export function computeMelSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  settings: AnalysisSettings,
): SpectrogramResult {
  // First compute full spectrogram (all freq bins)
  const fullSettings = { ...settings, minFrequency: 0, maxFrequency: sampleRate / 2 };
  const fullSpec = computeSpectrogram(samples, sampleRate, fullSettings);

  const { melFilterNum, minFrequency, maxFrequency } = settings;
  const halfSize = Math.floor(settings.windowSize / 2);
  const freqPerBin = sampleRate / settings.windowSize;

  // Build mel filter bank
  const melMin = hzToMel(minFrequency);
  const melMax = hzToMel(maxFrequency);
  const melStep = (melMax - melMin) / (melFilterNum + 1);

  const melCenters: number[] = [];
  for (let i = 0; i <= melFilterNum + 1; i++) {
    melCenters.push(melToHz(melMin + i * melStep));
  }

  // Apply mel filters to each frame
  const melFrames: Float32Array[] = [];
  let globalMax = 1e-30;

  for (const dbFrame of fullSpec.data) {
    // Convert back from dB to power for mel filtering
    const power = new Float32Array(dbFrame.length);
    for (let j = 0; j < dbFrame.length; j++) {
      power[j] = Math.pow(10, dbFrame[j] / 10);
    }

    const melBins = new Float32Array(melFilterNum);
    for (let m = 0; m < melFilterNum; m++) {
      const startHz = melCenters[m];
      const centerHz = melCenters[m + 1];
      const endHz = melCenters[m + 2];

      let sum = 0;
      const startBin = Math.floor(startHz / freqPerBin);
      const endBin = Math.min(halfSize, Math.ceil(endHz / freqPerBin));

      for (let j = startBin; j < endBin && j < power.length; j++) {
        const freq = j * freqPerBin;
        let weight = 0;
        if (freq >= startHz && freq <= centerHz && centerHz > startHz) {
          weight = (freq - startHz) / (centerHz - startHz);
        } else if (freq > centerHz && freq <= endHz && endHz > centerHz) {
          weight = (endHz - freq) / (endHz - centerHz);
        }
        sum += power[j] * weight;
      }
      melBins[m] = sum;
      if (sum > globalMax) globalMax = sum;
    }
    melFrames.push(melBins);
  }

  // Normalize to dB
  const result: Float32Array[] = [];
  for (const mel of melFrames) {
    const db = new Float32Array(mel.length);
    for (let j = 0; j < mel.length; j++) {
      db[j] = 10 * Math.log10(Math.max(mel[j], 1e-30) / globalMax);
    }
    result.push(db);
  }

  return {
    data: result,
    numFrames: result.length,
    numBins: melFilterNum,
    freqPerBin: 0, // Not applicable for mel
    hopSize: fullSpec.hopSize,
    sampleRate,
    startIndex: fullSpec.startIndex,
    endIndex: fullSpec.endIndex,
  };
}

// ---------------------------------------------------------------------------
// Spectrogram color map (6-class, adapted from vscode-audio-preview)
// ---------------------------------------------------------------------------

export function spectrogramColor(ampDb: number, rangeDb: number): [number, number, number] {
  if (ampDb === null || ampDb === undefined) return [0, 0, 0];
  const range = Math.abs(rangeDb);
  if (range === 0) return [0, 0, 0];

  const classWidth = range / 6;
  const amp = Math.abs(ampDb);
  const ampClass = Math.min(5, Math.floor(amp / classWidth));
  const posInClass = (amp - ampClass * classWidth) / classWidth;
  const v = Math.round(posInClass * 130 + 125);
  const vi = 255 - v + 125;

  switch (ampClass) {
    case 0: return [255, 255, v];       // white → yellow
    case 1: return [255, vi, 125];      // yellow → orange/red
    case 2: return [vi, 0, 125];        // red → magenta
    case 3: return [vi, 0, 125];        // magenta → purple
    case 4: return [Math.max(0, vi - 125), 0, vi]; // purple → dark blue
    case 5: return [0, 0, Math.max(0, vi - 125)];  // dark blue → black
    default: return [0, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// Nice number for axis labels (adapted from vscode-audio-preview)
// ---------------------------------------------------------------------------

export function roundToNearestNiceNumber(input: number): [number, number] {
  if (input <= 0) return [0, 0];
  const exp = Math.floor(Math.log10(input));
  const mantissa = input / Math.pow(10, exp);

  let nice: number;
  if (mantissa < 1.5) nice = 1;
  else if (mantissa < 3.5) nice = 2;
  else if (mantissa < 7.5) nice = 5;
  else nice = 10;

  const result = nice * Math.pow(10, exp);
  const decimals = Math.max(0, -exp + (nice === 1 ? 0 : nice === 2 ? 0 : 0));
  return [result, decimals];
}

// ---------------------------------------------------------------------------
// Waveform downsampling
// ---------------------------------------------------------------------------

export function downsampleForDisplay(
  data: Float32Array,
  startIndex: number,
  endIndex: number,
  maxPoints: number,
): { samples: Float32Array; step: number; offset: number } {
  const len = endIndex - startIndex;
  if (len <= maxPoints) {
    return { samples: data.subarray(startIndex, endIndex), step: 1, offset: startIndex };
  }
  const step = Math.ceil(len / maxPoints);
  const out = new Float32Array(Math.ceil(len / step));
  for (let i = 0, j = 0; i < len; i += step, j++) {
    out[j] = data[startIndex + i];
  }
  return { samples: out, step, offset: startIndex };
}

// ---------------------------------------------------------------------------
// WAV encoder (for EasyCut export)
// ---------------------------------------------------------------------------

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  const numChannels = channels.length;
  const numSamples = channels[0].length;
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);        // chunk size
  view.setUint16(20, 1, true);         // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let s = 0; s < numSamples; s++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = channels[ch][s];
      const int16 = sample < 0
        ? Math.max(-32768, Math.round(sample * 32768))
        : Math.min(32767, Math.round(sample * 32767));
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

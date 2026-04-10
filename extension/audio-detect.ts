/**
 * Audio dataset detection utilities.
 *
 * Two types of audio data in HDF5/MAT files:
 * 1. Encoded blobs: dataset name ends with .mp3/.wav/.flac/etc., content is encoded binary
 * 2. PCM arrays: 1D or 2D numeric arrays that look like raw audio samples
 */

import type { AudioDatasetType, AudioHint } from './models.js';

const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|ogg|aac|m4a|opus|wma)$/i;

const SAMPLE_RATE_ATTR_NAMES = [
  'sample_rate', 'sampleRate', 'sampling_rate', 'samplingRate',
  'sr', 'fs', 'Fs', 'rate', 'frequency',
];

const NUMERIC_DTYPES = [
  'Integer', 'Float',
];

const MAX_ENCODED_BLOB_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_PCM_SAMPLES = 500_000_000; // 500 million samples

/**
 * Check if a dataset name suggests it's an encoded audio file.
 */
export function isAudioByName(name: string): boolean {
  return AUDIO_EXTENSIONS.test(name);
}

/**
 * Check if a dataset's shape and dtype suggest PCM audio data.
 */
export function isAudioByShape(
  shape: number[] | null | undefined,
  dtypeClass: string | undefined,
): boolean {
  if (!shape || !dtypeClass) return false;
  if (!NUMERIC_DTYPES.includes(dtypeClass)) return false;

  if (shape.length === 1) {
    return shape[0] >= 8000;
  }

  if (shape.length === 2) {
    const [a, b] = shape;
    // One dimension <= 8 (channels), other >= 8000 (samples)
    return (a <= 8 && b >= 8000) || (b <= 8 && a >= 8000);
  }

  return false;
}

/**
 * Try to extract sample rate from attribute values.
 */
export function extractSampleRate(attrValues: Record<string, unknown>): number {
  for (const name of SAMPLE_RATE_ATTR_NAMES) {
    const val = attrValues[name];
    if (typeof val === 'number' && val > 0) return val;
  }
  return 0;
}

/**
 * Infer channel count and sample count from shape.
 */
export function inferAudioLayout(shape: number[]): { numChannels: number; numSamples: number; channelFirst: boolean } {
  if (shape.length === 1) {
    return { numChannels: 1, numSamples: shape[0], channelFirst: false };
  }
  if (shape.length === 2) {
    const [a, b] = shape;
    if (a <= 8 && b >= 8000) {
      return { numChannels: a, numSamples: b, channelFirst: true };
    }
    return { numChannels: b, numSamples: a, channelFirst: false };
  }
  return { numChannels: 1, numSamples: 0, channelFirst: false };
}

/**
 * Build an AudioHint for an encoded blob dataset.
 */
export function makeEncodedBlobHint(path: string, name: string, dataSize: number): AudioHint {
  const hint: AudioHint = {
    path, name,
    audioType: 'encoded-blob',
    sampleRate: 0,
    numChannels: 0,
    numSamples: 0,
    dataSize,
  };

  if (dataSize > MAX_ENCODED_BLOB_BYTES) {
    hint.warning = `Large audio file (${(dataSize / 1024 / 1024).toFixed(0)} MB). Loading may take a while.`;
  }

  return hint;
}

/**
 * Build an AudioHint for a PCM array dataset.
 */
export function makePcmArrayHint(
  path: string,
  name: string,
  shape: number[],
  dtypeClass: string,
  attrValues: Record<string, unknown>,
): AudioHint {
  const { numChannels, numSamples } = inferAudioLayout(shape);
  const sampleRate = extractSampleRate(attrValues);
  const totalSamples = numChannels * numSamples;

  const hint: AudioHint = {
    path, name,
    audioType: 'pcm-array',
    sampleRate,
    numChannels,
    numSamples,
    dataSize: totalSamples,
  };

  if (totalSamples > MAX_PCM_SAMPLES) {
    hint.warning = `Very large audio dataset (${(totalSamples / 1_000_000).toFixed(0)}M samples). Playback may be slow or crash the browser.`;
  }

  return hint;
}

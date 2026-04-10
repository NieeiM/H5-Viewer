/**
 * Neuroscan CNT file parser.
 *
 * Binary format with fixed-size headers:
 *   - 900-byte SETUP header (patient info, recording params)
 *   - 75-byte ELECTLOC per channel (label, calibration, position)
 *   - Interleaved raw EEG samples (int16 or int32)
 *   - Event table at end of file
 *
 * References:
 *   - Paul Bourke's sethead.h (http://paulbourke.net/dataformats/eeg/)
 *   - MNE-Python mne/io/cnt/ (BSD-3-Clause)
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { Logger } from './h5-service.js';

// ---------------------------------------------------------------------------
// Header offsets (from Paul Bourke / MNE-Python)
// ---------------------------------------------------------------------------

const SETUP_SIZE = 900;
const CH_SIZE = 75;

// SETUP header field offsets
const OFS_REV = 0;          // 20 bytes, revision string
const OFS_TYPE = 20;        // 1 byte, 0=EEG 1=AVG
const OFS_ID = 21;          // 20 bytes, patient ID
const OFS_NCHAN = 370;      // uint16, number of channels
const OFS_RATE = 376;       // uint16, sampling rate Hz
const OFS_NUMSAMPLES = 864; // int32, num samples (unreliable)
const OFS_EVTPOS = 886;     // int32, event table file position
const OFS_CHANOFFSET = 894; // int32, channel offset (block size)

// ELECTLOC field offsets (relative to channel header start)
const CH_OFS_LAB = 0;       // 10 bytes, channel label
const CH_OFS_X = 19;        // float32, x screen coord
const CH_OFS_Y = 23;        // float32, y screen coord
const CH_OFS_BASELINE = 47; // int16, baseline AD units
const CH_OFS_SENS = 59;     // float32, sensitivity
const CH_OFS_CALIB = 71;    // float32, calibration factor

// Event structures
const EVENT1_SIZE = 8;
const EVENT2_SIZE = 19;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NeuroscanChannel {
  label: string;
  xCoord: number;
  yCoord: number;
  baseline: number;
  sensitivity: number;
  calib: number;
  /** Conversion factor: physical_uV = (raw - baseline) * cal */
  cal: number;
}

export interface NeuroscanEvent {
  stimType: number;
  sampleIndex: number;
  keyboard: number;
  keypadAccept: number;
}

export interface NeuroscanHeader {
  revision: string;
  type: number;
  patientId: string;
  nChannels: number;
  sampleRate: number;
  numSamples: number;
  channels: NeuroscanChannel[];
  events: NeuroscanEvent[];
  dataFormat: 'int16' | 'int32';
  dataStartOffset: number;
  eventTablePos: number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class NeuroscanParser {
  private fd: number = -1;
  private header: NeuroscanHeader | null = null;
  private log: Logger;

  constructor(logger: Logger) {
    this.log = logger;
  }

  open(filePath: string): NeuroscanHeader {
    const t0 = performance.now();
    this.fd = openSync(filePath, 'r');
    const fileSize = statSync(filePath).size;

    // Read SETUP header
    const setupBuf = Buffer.alloc(SETUP_SIZE);
    readSync(this.fd, setupBuf, 0, SETUP_SIZE, 0);

    const revision = this.readString(setupBuf, OFS_REV, 20);
    const type = setupBuf.readUInt8(OFS_TYPE);
    const patientId = this.readString(setupBuf, OFS_ID, 20);
    const nChannels = setupBuf.readUInt16LE(OFS_NCHAN);
    const sampleRate = setupBuf.readUInt16LE(OFS_RATE);
    const numSamplesRaw = setupBuf.readInt32LE(OFS_NUMSAMPLES);
    const evtPosRaw = setupBuf.readInt32LE(OFS_EVTPOS);
    const channelOffset = setupBuf.readInt32LE(OFS_CHANOFFSET);

    this.log.debug(`[Neuroscan] revision="${revision}", nch=${nChannels}, rate=${sampleRate}`);
    this.log.debug(`[Neuroscan] numSamples(raw)=${numSamplesRaw}, evtPos(raw)=${evtPosRaw}, chanOffset=${channelOffset}`);

    // Read channel headers
    const chHeaderSize = CH_SIZE * nChannels;
    const chBuf = Buffer.alloc(chHeaderSize);
    readSync(this.fd, chBuf, 0, chHeaderSize, SETUP_SIZE);

    const channels: NeuroscanChannel[] = [];
    for (let i = 0; i < nChannels; i++) {
      const base = i * CH_SIZE;
      const label = this.readString(chBuf, base + CH_OFS_LAB, 10);
      const xCoord = chBuf.readFloatLE(base + CH_OFS_X);
      const yCoord = chBuf.readFloatLE(base + CH_OFS_Y);
      const baseline = chBuf.readInt16LE(base + CH_OFS_BASELINE);
      const sensitivity = chBuf.readFloatLE(base + CH_OFS_SENS);
      const calib = chBuf.readFloatLE(base + CH_OFS_CALIB);

      // Physical value conversion: uV = (raw - baseline) * calib * sensitivity / 204.8
      const cal = (calib * sensitivity) / 204.8;

      channels.push({ label, xCoord, yCoord, baseline, sensitivity, calib, cal });
    }

    // Determine data format (int16 vs int32) and compute robust sample count
    const dataStartOffset = SETUP_SIZE + chHeaderSize;

    // EventTablePos may overflow for files >= 2GB
    let eventTablePos: number;
    if (evtPosRaw > 0 && evtPosRaw > dataStartOffset) {
      eventTablePos = evtPosRaw;
    } else {
      // Fallback: assume event table is at end of file
      // (not accurate but best we can do)
      eventTablePos = fileSize;
    }

    const nDataBytes = eventTablePos - dataStartOffset;

    // Auto-detect: try int16 first, then int32
    let dataFormat: 'int16' | 'int32';
    let numSamples: number;

    if (numSamplesRaw > 0) {
      const bytesPerSample = nDataBytes / nChannels / numSamplesRaw;
      if (Math.abs(bytesPerSample - 2) < 0.01) {
        dataFormat = 'int16';
        numSamples = numSamplesRaw;
      } else if (Math.abs(bytesPerSample - 4) < 0.01) {
        dataFormat = 'int32';
        numSamples = numSamplesRaw;
      } else {
        // Heuristic: try int16
        const ns16 = nDataBytes / nChannels / 2;
        const ns32 = nDataBytes / nChannels / 4;
        if (Number.isInteger(ns16)) {
          dataFormat = 'int16';
          numSamples = ns16;
        } else if (Number.isInteger(ns32)) {
          dataFormat = 'int32';
          numSamples = ns32;
        } else {
          dataFormat = 'int16';
          numSamples = Math.floor(ns16);
        }
      }
    } else {
      // numSamples invalid, compute from data size
      const ns32 = nDataBytes / nChannels / 4;
      if (Number.isInteger(ns32) && ns32 > 0) {
        dataFormat = 'int32';
        numSamples = ns32;
      } else {
        dataFormat = 'int16';
        numSamples = Math.floor(nDataBytes / nChannels / 2);
      }
    }

    this.log.debug(`[Neuroscan] dataFormat=${dataFormat}, numSamples=${numSamples}`);

    // Read events
    const events = this.readEvents(eventTablePos, fileSize, dataStartOffset, nChannels, dataFormat === 'int16' ? 2 : 4);

    this.header = {
      revision, type, patientId, nChannels, sampleRate,
      numSamples, channels, events, dataFormat,
      dataStartOffset, eventTablePos,
    };

    this.log.info(`[Neuroscan] Opened in ${(performance.now() - t0).toFixed(0)} ms: ${nChannels} channels, ${sampleRate} Hz, ${numSamples} samples (${(numSamples / sampleRate).toFixed(1)} sec), ${dataFormat}, ${events.length} events`);

    return this.header;
  }

  /**
   * Read raw data for a specific channel, applying calibration to get µV.
   * Returns Float64Array of physical values.
   */
  readChannel(channelIndex: number, startSample = 0, endSample?: number): Float64Array {
    if (!this.header || this.fd === -1) throw new Error('File not open');

    const h = this.header;
    const end = endSample ?? h.numSamples;
    const nSamples = end - startSample;
    const bytesPerSample = h.dataFormat === 'int16' ? 2 : 4;
    const rowSize = h.nChannels * bytesPerSample;
    const ch = h.channels[channelIndex];
    const result = new Float64Array(nSamples);

    // Read sample by sample (channel-interleaved)
    // For efficiency, read in chunks
    const CHUNK = 4096; // samples per read
    const chunkBuf = Buffer.alloc(CHUNK * rowSize);

    for (let s = 0; s < nSamples; s += CHUNK) {
      const n = Math.min(CHUNK, nSamples - s);
      const fileOffset = h.dataStartOffset + (startSample + s) * rowSize;
      readSync(this.fd, chunkBuf, 0, n * rowSize, fileOffset);

      for (let i = 0; i < n; i++) {
        const sampleOffset = i * rowSize + channelIndex * bytesPerSample;
        const raw = h.dataFormat === 'int16'
          ? chunkBuf.readInt16LE(sampleOffset)
          : chunkBuf.readInt32LE(sampleOffset);
        result[s + i] = (raw - ch.baseline) * ch.cal;
      }
    }

    return result;
  }

  /**
   * Read a time range across all channels. Returns nChannels x nSamples flat array.
   */
  readAllChannels(startSample = 0, endSample?: number): Float64Array {
    if (!this.header || this.fd === -1) throw new Error('File not open');

    const h = this.header;
    const end = endSample ?? h.numSamples;
    const nSamples = end - startSample;
    const bytesPerSample = h.dataFormat === 'int16' ? 2 : 4;
    const rowSize = h.nChannels * bytesPerSample;

    // Output: [ch0_s0, ch0_s1, ..., ch1_s0, ch1_s1, ...]
    const result = new Float64Array(h.nChannels * nSamples);

    const CHUNK = 2048;
    const chunkBuf = Buffer.alloc(CHUNK * rowSize);

    for (let s = 0; s < nSamples; s += CHUNK) {
      const n = Math.min(CHUNK, nSamples - s);
      const fileOffset = h.dataStartOffset + (startSample + s) * rowSize;
      readSync(this.fd, chunkBuf, 0, n * rowSize, fileOffset);

      for (let i = 0; i < n; i++) {
        for (let ch = 0; ch < h.nChannels; ch++) {
          const sampleOffset = i * rowSize + ch * bytesPerSample;
          const raw = h.dataFormat === 'int16'
            ? chunkBuf.readInt16LE(sampleOffset)
            : chunkBuf.readInt32LE(sampleOffset);
          result[ch * nSamples + (s + i)] = (raw - h.channels[ch].baseline) * h.channels[ch].cal;
        }
      }
    }

    return result;
  }

  getHeader(): NeuroscanHeader {
    if (!this.header) throw new Error('File not open');
    return this.header;
  }

  close(): void {
    if (this.fd !== -1) {
      closeSync(this.fd);
      this.fd = -1;
    }
    this.header = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private readEvents(evtPos: number, fileSize: number, dataStart: number, nChannels: number, bytesPerSample: number): NeuroscanEvent[] {
    if (evtPos <= 0 || evtPos >= fileSize) return [];

    try {
      // Read TEEG header (9 bytes)
      const teegBuf = Buffer.alloc(9);
      readSync(this.fd, teegBuf, 0, 9, evtPos);

      const teegType = teegBuf.readUInt8(0);
      const teegSize = teegBuf.readInt32LE(1);

      if (teegSize <= 0) return [];

      const eventSize = teegType === 1 ? EVENT1_SIZE : EVENT2_SIZE;
      const nEvents = Math.floor(teegSize / eventSize);

      if (nEvents <= 0 || nEvents > 1_000_000) return [];

      const evtBuf = Buffer.alloc(teegSize);
      readSync(this.fd, evtBuf, 0, teegSize, evtPos + 9);

      const events: NeuroscanEvent[] = [];
      for (let i = 0; i < nEvents; i++) {
        const base = i * eventSize;
        const stimType = evtBuf.readUInt16LE(base);
        const keyboard = evtBuf.readUInt8(base + 2);
        const keypadAccept = evtBuf.readInt8(base + 3);
        let offset = evtBuf.readInt32LE(base + 4);

        // Event type 3: offset is in sample units, not bytes
        if (teegType === 3) {
          offset = offset * bytesPerSample * nChannels;
        }

        // Convert byte offset to sample index
        let sampleIndex = Math.floor((offset - dataStart) / (nChannels * bytesPerSample)) - 1;
        if (sampleIndex < 0) sampleIndex = 0;

        events.push({ stimType, sampleIndex, keyboard, keypadAccept });
      }

      this.log.debug(`[Neuroscan] Read ${events.length} events (type ${teegType})`);
      return events;
    } catch {
      this.log.warn('[Neuroscan] Failed to read event table');
      return [];
    }
  }

  private readString(buf: Buffer, offset: number, length: number): string {
    let end = offset + length;
    while (end > offset && (buf[end - 1] === 0 || buf[end - 1] === 0x20)) end--;
    return buf.toString('ascii', offset, end);
  }
}

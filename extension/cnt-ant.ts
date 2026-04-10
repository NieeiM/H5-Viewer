/**
 * ANT Neuro CNT file parser.
 *
 * RIFF-based container format with RAW3 compressed EEG data.
 * Ported from libeep (LGPL-3.0) C source code:
 *   - raw3.c: RAW3 compression/decompression algorithm
 *   - cnt.c: RIFF chunk reading and eeph header parsing
 *   - riff.c: RIFF container navigation
 *
 * Original copyright:
 *   Copyright (c) 2003-2009
 *   Advanced Neuro Technology (ANT) B.V., Enschede, The Netherlands
 *   Max-Planck Institute for Human Cognitive & Brain Sciences, Leipzig, Germany
 *
 * This port is distributed under LGPL-3.0 (compatible with our GPL-3.0).
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { Logger } from './h5-service.js';

// ---------------------------------------------------------------------------
// RIFF constants
// ---------------------------------------------------------------------------

function fourcc(a: string, b: string, c: string, d: string): number {
  return a.charCodeAt(0) | (b.charCodeAt(0) << 8) | (c.charCodeAt(0) << 16) | (d.charCodeAt(0) << 24);
}

const FOURCC_RIFF = fourcc('R', 'I', 'F', 'F');
const FOURCC_RF64 = fourcc('R', 'F', '6', '4');
const FOURCC_LIST = fourcc('L', 'I', 'S', 'T');
const FOURCC_CNT = fourcc('C', 'N', 'T', ' ');
const FOURCC_raw3 = fourcc('r', 'a', 'w', '3');
const FOURCC_chan = fourcc('c', 'h', 'a', 'n');
const FOURCC_data = fourcc('d', 'a', 't', 'a');
const FOURCC_ep = fourcc('e', 'p', ' ', ' ');
const FOURCC_eeph = fourcc('e', 'e', 'p', 'h');
const FOURCC_evt = fourcc('e', 'v', 't', ' ');
const FOURCC_info = fourcc('i', 'n', 'f', 'o');

function fourccToString(fc: number): string {
  return String.fromCharCode(fc & 0xff, (fc >> 8) & 0xff, (fc >> 16) & 0xff, (fc >> 24) & 0xff);
}

// ---------------------------------------------------------------------------
// RIFF chunk reader
// ---------------------------------------------------------------------------

interface RiffChunk {
  id: number;
  start: number;  // file offset of data (after id+size header)
  size: number;    // data size in bytes
}

class RiffReader {
  constructor(private fd: number) {}

  readFormChunk(offset: number): { chunk: RiffChunk; formType: number; is64bit: boolean } {
    const buf = Buffer.alloc(12);
    readSync(this.fd, buf, 0, 12, offset);

    const id = buf.readUInt32LE(0);
    const size = buf.readUInt32LE(4);
    const formType = buf.readUInt32LE(8);

    const is64bit = id === FOURCC_RF64;
    // For RIFF: data starts after the 12-byte header (id+size+formtype)
    return {
      chunk: { id, start: offset + 12, size: size - 4 },
      formType,
      is64bit,
    };
  }

  /** Find a subchunk within a parent chunk by its FOURCC id */
  findSubchunk(parent: RiffChunk, targetId: number): RiffChunk | null {
    let pos = parent.start;
    const end = parent.start + parent.size;

    while (pos + 8 <= end) {
      const hdr = Buffer.alloc(8);
      readSync(this.fd, hdr, 0, 8, pos);
      const id = hdr.readUInt32LE(0);
      const size = hdr.readUInt32LE(4);

      if (id === targetId) {
        return { id, start: pos + 8, size };
      }

      // LIST chunks have an extra 4-byte list type
      if (id === FOURCC_LIST) {
        // Check if the LIST's type matches
        const listType = Buffer.alloc(4);
        readSync(this.fd, listType, 0, 4, pos + 8);
        const lt = listType.readUInt32LE(0);
        if (lt === targetId) {
          // Return the LIST content (after id+size+listtype = 12 bytes)
          return { id: lt, start: pos + 12, size: size - 4 };
        }
      }

      // Move to next chunk (aligned to 2 bytes)
      pos += 8 + size + (size % 2);
    }

    return null;
  }

  /** Find all subchunks within a parent */
  findAllSubchunks(parent: RiffChunk): Array<{ id: number; chunk: RiffChunk }> {
    const result: Array<{ id: number; chunk: RiffChunk }> = [];
    let pos = parent.start;
    const end = parent.start + parent.size;

    while (pos + 8 <= end) {
      const hdr = Buffer.alloc(8);
      readSync(this.fd, hdr, 0, 8, pos);
      const id = hdr.readUInt32LE(0);
      const size = hdr.readUInt32LE(4);

      result.push({ id, chunk: { id, start: pos + 8, size } });
      pos += 8 + size + (size % 2);
    }

    return result;
  }

  readChunkData(chunk: RiffChunk): Buffer {
    const buf = Buffer.alloc(chunk.size);
    readSync(this.fd, buf, 0, chunk.size, chunk.start);
    return buf;
  }
}

// ---------------------------------------------------------------------------
// RAW3 decompression — ported from libeep raw3.c
// ---------------------------------------------------------------------------

// Prediction methods (stored in data files, never change)
const RAW3_COPY = 0;
const RAW3_TIME = 1;
const RAW3_TIME2 = 2;
const RAW3_CHAN = 3;
const RAW3_COPY_32 = 8;

/**
 * Decode a huffman-compressed 16-bit data vector.
 * Ported from dehuffman16() in raw3.c.
 */
function dehuffman16(inp: Uint8Array, n: number): { method: number; data: Int32Array; bytesRead: number } {
  const out = new Int32Array(n);

  const negmask = new Int32Array([
    -1, -2, -4, -8, -16, -32, -64, -128,
    -256, -512, -1024, -2048, -4096, -8192, -16384, -32768,
    -65536, -131072, -262144, -524288, -1048576, -2097152, -4194304, -8388608,
    -16777216, -33554432, -67108864, -134217728, -268435456, -536870912, -1073741824, -2147483648,
    0,
  ]);

  const posmask = new Uint32Array([
    0x00000000, 0x00000001, 0x00000003, 0x00000007,
    0x0000000f, 0x0000001f, 0x0000003f, 0x0000007f,
    0x000000ff, 0x000001ff, 0x000003ff, 0x000007ff,
    0x00000fff, 0x00001fff, 0x00003fff, 0x00007fff,
    0x0000ffff, 0x0001ffff, 0x0003ffff, 0x0007ffff,
    0x000fffff, 0x001fffff, 0x003fffff, 0x007fffff,
    0x00ffffff, 0x01ffffff, 0x03ffffff, 0x07ffffff,
    0x0fffffff, 0x1fffffff, 0x3fffffff, 0x7fffffff,
    0xffffffff,
  ]);

  const setbit = [
    0x0001, 0x0002, 0x0004, 0x0008,
    0x0010, 0x0020, 0x0040, 0x0080,
    0x0100, 0x0200, 0x0400, 0x0800,
    0x1000, 0x2000, 0x4000, 0x8000,
  ];

  const method = (inp[0] >> 4) & 0x0f;

  if (method !== RAW3_COPY) {
    let nbit = inp[0] & 0x0f;
    if (nbit === 0) nbit = 16;
    const nbit_1 = nbit - 1;
    let nexcbit = (inp[1] >> 4) & 0x0f;
    if (nexcbit === 0) nexcbit = 16;
    const nexcbit_1 = nexcbit - 1;
    const excval = -(1 << nbit_1);
    const check_exc = nbit !== nexcbit;

    // Read first sample (16-bit)
    out[0] = ((inp[1] & 0x0f) << 12) | (inp[2] << 4) | ((inp[3] >> 4) & 0x0f);
    if (out[0] & 0x8000) out[0] |= 0xffff0000;  // sign extend

    let bitin = 28;
    let nout = 1;

    if (nbit < 9) {
      while (nout < n) {
        const hibytein = bitin >> 3;
        const iwork = (inp[hibytein] << 8) + inp[hibytein + 1];
        let swork = (iwork >> (((hibytein + 2) << 3) - bitin - nbit)) | 0;

        if (swork & setbit[nbit_1]) {
          swork |= negmask[nbit];
        } else {
          swork &= posmask[nbit];
        }

        bitin += nbit;

        if (swork === excval && check_exc) {
          const hbe = bitin >> 3;
          const iw = (inp[hbe] << 16) + (inp[hbe + 1] << 8) + inp[hbe + 2];
          swork = (iw >> (((hbe + 3) << 3) - bitin - nexcbit)) | 0;
          if (swork & setbit[nexcbit_1]) {
            swork |= negmask[nexcbit];
          } else {
            swork &= posmask[nexcbit];
          }
          bitin += nexcbit;
        }

        out[nout++] = swork;
      }
    } else {
      while (nout < n) {
        const hibytein = bitin >> 3;
        const iwork = (inp[hibytein] << 16) + (inp[hibytein + 1] << 8) + inp[hibytein + 2];
        let swork = (iwork >> (((hibytein + 3) << 3) - bitin - nbit)) | 0;

        if (swork & setbit[nbit_1]) {
          swork |= negmask[nbit];
        } else {
          swork &= posmask[nbit];
        }

        bitin += nbit;

        if (swork === excval && nbit !== nexcbit) {
          const hbe = bitin >> 3;
          const iw = (inp[hbe] << 16) + (inp[hbe + 1] << 8) + inp[hbe + 2];
          swork = (iw >> (((hbe + 3) << 3) - bitin - nexcbit)) | 0;
          if (swork & setbit[nexcbit_1]) {
            swork |= negmask[nexcbit];
          } else {
            swork &= posmask[nexcbit];
          }
          bitin += nexcbit;
        }

        out[nout++] = swork;
      }
    }

    let nin = bitin >> 3;
    if (bitin & 0x07) nin++;
    return { method, data: out, bytesRead: nin };
  }

  // RAW3_COPY
  let nin = 1;
  for (let nout = 0; nout < n; nout++) {
    out[nout] = (inp[nin] << 8) | inp[nin + 1];
    if (out[nout] > 32767) out[nout] -= 65536;
    nin += 2;
  }
  return { method, data: out, bytesRead: nin };
}

/**
 * Decode a huffman-compressed 32-bit data vector.
 * Ported from dehuffman32() in raw3.c.
 */
function dehuffman32(inp: Uint8Array, n: number): { method: number; data: Int32Array; bytesRead: number } {
  const out = new Int32Array(n);

  const setinbit = [
    0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80,
  ];
  const setoutbit = new Uint32Array([
    0x00000001, 0x00000002, 0x00000004, 0x00000008,
    0x00000010, 0x00000020, 0x00000040, 0x00000080,
    0x00000100, 0x00000200, 0x00000400, 0x00000800,
    0x00001000, 0x00002000, 0x00004000, 0x00008000,
    0x00010000, 0x00020000, 0x00040000, 0x00080000,
    0x00100000, 0x00200000, 0x00400000, 0x00800000,
    0x01000000, 0x02000000, 0x04000000, 0x08000000,
    0x10000000, 0x20000000, 0x40000000, 0x80000000,
  ]);
  const negmask = new Int32Array([
    -1, -2, -4, -8, -16, -32, -64, -128,
    -256, -512, -1024, -2048, -4096, -8192, -16384, -32768,
    -65536, -131072, -262144, -524288, -1048576, -2097152, -4194304, -8388608,
    -16777216, -33554432, -67108864, -134217728, -268435456, -536870912, -1073741824, -2147483648,
    0,
  ]);

  const method = (inp[0] >> 4) & 0x0f;

  if (method !== RAW3_COPY_32) {
    const nbit = ((inp[0] << 2) & 0x3c) | ((inp[1] >> 6) & 0x03);
    const nbit_1 = nbit - 1;
    const nexcbit = inp[1] & 0x3f;
    const nexcbit_1 = nexcbit - 1;

    out[0] = (inp[2] << 24) | (inp[3] << 16) | (inp[4] << 8) | inp[5];

    let nin = 6;
    let bitin = 7;
    let inval = inp[nin];
    let nout = 1;
    let bitout = nbit_1;
    let outval = 0;
    const excval = -(1 << nbit_1);
    const check_exc = nbit !== nexcbit;

    while (nout < n) {
      if (inval & setinbit[bitin]) {
        outval |= setoutbit[bitout];
        if (bitout === nbit_1) {
          outval |= negmask[nbit];
        }
      }

      bitin--;
      if (bitin < 0) {
        nin++;
        bitin = 7;
        inval = inp[nin];
      }

      bitout--;

      if (bitout < 0) {
        if (outval === excval && check_exc) {
          outval = 0;
          for (bitout = nexcbit_1; bitout >= 0; bitout--) {
            if (inval & setinbit[bitin]) {
              outval |= setoutbit[bitout];
              if (bitout === nexcbit_1) {
                outval |= negmask[nexcbit];
              }
            }
            bitin--;
            if (bitin < 0) {
              nin++;
              bitin = 7;
              inval = inp[nin];
            }
          }
        }

        out[nout++] = outval;
        outval = 0;
        bitout = nbit - 1;
      }
    }

    if (bitin !== 7) nin++;
    return { method, data: out, bytesRead: nin };
  }

  // RAW3_COPY_32
  let nin = 1;
  for (let nout = 0; nout < n; nout++) {
    out[nout] = (inp[nin] << 24) | (inp[nin + 1] << 16) | (inp[nin + 2] << 8) | inp[nin + 3];
    nin += 4;
  }
  return { method, data: out, bytesRead: nin };
}

/**
 * Decode a huffman vector, auto-detecting 16 vs 32 bit.
 * Ported from dehuffman() in raw3.c.
 */
function dehuffman(inp: Uint8Array, n: number): { method: number; data: Int32Array; bytesRead: number } {
  if (inp[0] & 0x80) {
    return dehuffman32(inp, n);
  }
  return dehuffman16(inp, n);
}

/**
 * Decompress one channel's data within an epoch.
 * Ported from decompchan() in raw3.c.
 */
function decompchan(last: Int32Array, cur: Int32Array, n: number, inp: Uint8Array, inOffset: number): number {
  const { method, data: res, bytesRead } = dehuffman(inp.subarray(inOffset), n);

  const m = method & 0x07;
  switch (m) {
    case RAW3_TIME:
      cur[0] = res[0];
      for (let s = 1; s < n; s++) {
        cur[s] = cur[s - 1] + res[s];
      }
      break;

    case RAW3_TIME2:
      cur[0] = res[0];
      cur[1] = cur[0] + res[1];
      for (let s = 2; s < n; s++) {
        cur[s] = 2 * cur[s - 1] - cur[s - 2] + res[s];
      }
      break;

    case RAW3_CHAN:
      cur[0] = res[0];
      for (let s = 1; s < n; s++) {
        cur[s] = cur[s - 1] + last[s] - last[s - 1] + res[s];
      }
      break;

    case RAW3_COPY:
      cur.set(res);
      break;

    default:
      // Unknown method, treat as copy
      cur.set(res);
      break;
  }

  return bytesRead;
}

/**
 * Decompress a full epoch (all channels).
 * Ported from decompepoch_mux() in raw3.c.
 *
 * @param chanSeq Channel prediction sequence
 * @param chanc Number of channels
 * @param epochLength Samples per epoch
 * @param compressedData Compressed epoch data
 * @returns MUX format output: [ch0_s0, ch1_s0, ..., ch0_s1, ch1_s1, ...]
 */
function decompressEpoch(
  chanSeq: Int16Array,
  chanc: number,
  epochLength: number,
  compressedData: Uint8Array,
): Int32Array {
  const output = new Int32Array(chanc * epochLength);
  let cur = new Int32Array(epochLength);
  let last = new Int32Array(epochLength); // initialized to 0

  let inOffset = 0;

  for (let ch = 0; ch < chanc; ch++) {
    // Decompress this channel
    const bytesUsed = decompchan(last, cur, epochLength, compressedData, inOffset);
    inOffset += bytesUsed;

    // De-mux: place into output at the right channel position
    const chanIdx = chanSeq[ch];
    let samplePos = chanIdx;
    for (let s = 0; s < epochLength; s++) {
      output[samplePos] = cur[s];
      samplePos += chanc;
    }

    // Swap cur ↔ last for next channel's prediction
    const tmp = cur;
    cur = last;
    last = tmp;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AntChannel {
  label: string;
  iscale: number;
  rscale: number;
  unit: string;
  refLabel: string;
  status: string;
  type: string;
}

export interface AntTrigger {
  code: string;
  sampleIndex: number;
  duration: number;
}

export interface AntHeader {
  sampleRate: number;
  nChannels: number;
  nSamples: number;
  channels: AntChannel[];
  triggers: AntTrigger[];
  epochLength: number;
  fileVersionMajor: number;
  fileVersionMinor: number;
}

// ---------------------------------------------------------------------------
// ANT Neuro parser
// ---------------------------------------------------------------------------

export class AntParser {
  private fd: number = -1;
  private header: AntHeader | null = null;
  private log: Logger;

  // RIFF structure
  private riff!: RiffReader;
  private raw3Chunk: RiffChunk | null = null;
  private dataChunk: RiffChunk | null = null;
  private epochOffsets: number[] = [];
  private chanSeq: Int16Array = new Int16Array(0);

  constructor(logger: Logger) {
    this.log = logger;
  }

  open(filePath: string): AntHeader {
    const t0 = performance.now();
    this.fd = openSync(filePath, 'r');
    this.riff = new RiffReader(this.fd);

    // Parse RIFF form
    const { chunk: rootChunk, formType, is64bit } = this.riff.readFormChunk(0);
    if (formType !== FOURCC_CNT) {
      throw new Error(`Not an ANT Neuro CNT file (form type: ${fourccToString(formType)})`);
    }
    this.log.debug(`[ANT] RIFF ${is64bit ? 'RF64' : 'RIFF'} form type: CNT, size: ${rootChunk.size}`);

    // Find eeph chunk (text header)
    const eephChunk = this.riff.findSubchunk(rootChunk, FOURCC_eeph);
    if (!eephChunk) throw new Error('Missing eeph chunk');

    const eephData = this.riff.readChunkData(eephChunk);
    const eephText = eephData.toString('utf-8');
    this.log.debug(`[ANT] eeph chunk: ${eephChunk.size} bytes`);

    // Parse text header
    const { sampleRate, nChannels, nSamples, channels, epochLength, fileVersionMajor, fileVersionMinor } =
      this.parseEephHeader(eephText);

    // Find raw3 LIST chunk (contains chan, data, ep subchunks)
    this.raw3Chunk = this.riff.findSubchunk(rootChunk, FOURCC_raw3);
    if (!this.raw3Chunk) throw new Error('Missing raw3 chunk');

    // Find chan subchunk (channel prediction sequence)
    const chanChunk = this.riff.findSubchunk(this.raw3Chunk, FOURCC_chan);
    if (chanChunk) {
      const chanData = this.riff.readChunkData(chanChunk);
      this.chanSeq = new Int16Array(nChannels);
      for (let i = 0; i < nChannels; i++) {
        this.chanSeq[i] = chanData.readInt16LE(i * 2);
      }
      this.log.debug(`[ANT] Channel sequence: [${Array.from(this.chanSeq).join(', ')}]`);
    } else {
      // Default: identity sequence
      this.chanSeq = new Int16Array(nChannels);
      for (let i = 0; i < nChannels; i++) this.chanSeq[i] = i;
    }

    // Find data subchunk
    this.dataChunk = this.riff.findSubchunk(this.raw3Chunk, FOURCC_data);
    if (!this.dataChunk) throw new Error('Missing data chunk');

    // Find ep (epoch table) subchunk
    const epChunk = this.riff.findSubchunk(this.raw3Chunk, FOURCC_ep);
    if (epChunk) {
      const epData = this.riff.readChunkData(epChunk);
      const nEpochs = Math.floor(epData.length / 8); // uint64 offsets
      this.epochOffsets = [];
      for (let i = 0; i < nEpochs; i++) {
        // Read as two 32-bit values (little-endian) for uint64
        const lo = epData.readUInt32LE(i * 8);
        const hi = epData.readUInt32LE(i * 8 + 4);
        this.epochOffsets.push(lo + hi * 0x100000000);
      }
      this.log.debug(`[ANT] ${this.epochOffsets.length} epochs, epochLength=${epochLength}`);
    }

    // Find evt (triggers) chunk
    const triggers = this.readTriggers(rootChunk);

    this.header = {
      sampleRate, nChannels, nSamples, channels, triggers,
      epochLength, fileVersionMajor, fileVersionMinor,
    };

    this.log.info(`[ANT] Opened in ${(performance.now() - t0).toFixed(0)} ms: ${nChannels} channels, ${sampleRate} Hz, ${nSamples} samples (${(nSamples / sampleRate).toFixed(1)} sec), ${this.epochOffsets.length} epochs, ${triggers.length} triggers`);

    return this.header;
  }

  /**
   * Read data for a specific channel, converting to physical units.
   * Uses epoch-based decompression with caching for efficiency.
   */
  readChannel(channelIndex: number, startSample = 0, endSample?: number): Float64Array {
    if (!this.header || this.fd === -1 || !this.dataChunk) {
      throw new Error('File not open');
    }

    const h = this.header;
    const end = endSample ?? h.nSamples;
    const nSamples = end - startSample;
    const result = new Float64Array(nSamples);
    const ch = h.channels[channelIndex];
    const scale = ch.iscale * ch.rscale;

    const startEpoch = Math.floor(startSample / h.epochLength);
    const endEpoch = Math.floor((end - 1) / h.epochLength);

    let resultOffset = 0;

    for (let ep = startEpoch; ep <= endEpoch; ep++) {
      const epochData = this.decompressEpochCached(ep);
      const epochStart = ep * h.epochLength;
      const readFrom = Math.max(startSample - epochStart, 0);
      const readTo = Math.min(end - epochStart, h.epochLength);

      for (let s = readFrom; s < readTo; s++) {
        const raw = epochData[s * h.nChannels + channelIndex];
        result[resultOffset++] = raw * scale;
      }
    }

    return result;
  }

  getHeader(): AntHeader {
    if (!this.header) throw new Error('File not open');
    return this.header;
  }

  close(): void {
    if (this.fd !== -1) {
      closeSync(this.fd);
      this.fd = -1;
    }
    this.header = null;
    this.epochCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Private: Epoch decompression with simple LRU cache
  // ---------------------------------------------------------------------------

  private epochCache = new Map<number, Int32Array>();
  private readonly MAX_CACHED_EPOCHS = 8;

  private decompressEpochCached(epochIndex: number): Int32Array {
    const cached = this.epochCache.get(epochIndex);
    if (cached) return cached;

    const data = this.decompressEpochRaw(epochIndex);

    // Simple eviction: remove oldest if cache is full
    if (this.epochCache.size >= this.MAX_CACHED_EPOCHS) {
      const firstKey = this.epochCache.keys().next().value;
      if (firstKey !== undefined) this.epochCache.delete(firstKey);
    }
    this.epochCache.set(epochIndex, data);
    return data;
  }

  private decompressEpochRaw(epochIndex: number): Int32Array {
    if (!this.dataChunk || !this.header) throw new Error('Not initialized');

    const h = this.header;

    // Determine the byte range for this epoch in the data chunk
    let epochOffset: number;
    let epochSize: number;

    if (this.epochOffsets.length > 0 && epochIndex < this.epochOffsets.length) {
      epochOffset = this.epochOffsets[epochIndex];
      if (epochIndex + 1 < this.epochOffsets.length) {
        epochSize = this.epochOffsets[epochIndex + 1] - epochOffset;
      } else {
        epochSize = this.dataChunk.size - epochOffset;
      }
    } else {
      // No epoch table — read entire data chunk (single epoch)
      epochOffset = 0;
      epochSize = this.dataChunk.size;
    }

    // Read compressed epoch data
    const compBuf = Buffer.alloc(epochSize);
    readSync(this.fd, compBuf, 0, epochSize, this.dataChunk.start + epochOffset);
    const compData = new Uint8Array(compBuf.buffer, compBuf.byteOffset, compBuf.byteLength);

    // Determine actual epoch length (last epoch may be shorter)
    const totalSamples = h.nSamples;
    const epochStart = epochIndex * h.epochLength;
    const thisEpochLength = Math.min(h.epochLength, totalSamples - epochStart);

    return decompressEpoch(this.chanSeq, h.nChannels, thisEpochLength, compData);
  }

  // ---------------------------------------------------------------------------
  // Private: Header parsing
  // ---------------------------------------------------------------------------

  private parseEephHeader(text: string): {
    sampleRate: number;
    nChannels: number;
    nSamples: number;
    channels: AntChannel[];
    epochLength: number;
    fileVersionMajor: number;
    fileVersionMinor: number;
  } {
    const lines = text.split('\n');
    let sampleRate = 0;
    let nChannels = 0;
    let nSamples = 0;
    let epochLength = 0;
    let fileVersionMajor = 4;
    let fileVersionMinor = 0;
    const channels: AntChannel[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      if (line === '[File Version]') {
        i++;
        const parts = lines[i]?.trim().split('.');
        if (parts && parts.length >= 2) {
          fileVersionMajor = parseInt(parts[0], 10) || 4;
          fileVersionMinor = parseInt(parts[1], 10) || 0;
        }
      } else if (line === '[Sampling Rate]') {
        i++;
        const rate = parseFloat(lines[i]?.trim() || '0');
        sampleRate = Math.round(rate); // rate is in Hz
      } else if (line === '[Samples]') {
        i++;
        nSamples = parseInt(lines[i]?.trim() || '0', 10);
      } else if (line === '[Channels]') {
        i++;
        nChannels = parseInt(lines[i]?.trim() || '0', 10);
      } else if (line === '[Epochs]') {
        i++;
        epochLength = parseInt(lines[i]?.trim() || '0', 10);
      } else if (line === '[Basic Channel Data]') {
        i++;
        // Skip comment lines starting with ;
        while (i < lines.length && lines[i].trim().startsWith(';')) i++;

        // Parse channel lines
        for (let ch = 0; ch < nChannels && i < lines.length; ch++) {
          const chLine = lines[i]?.trim();
          if (!chLine || chLine.startsWith('[')) break;

          const parts = chLine.split(/\s+/);
          const label = parts[0] || `ch${ch}`;
          const iscale = parseFloat(parts[1] || '1');
          const rscale = parseFloat(parts[2] || '1');
          const unit = parts[3] || 'uV';

          let refLabel = '';
          let status = '';
          let type = '';

          for (let p = 4; p < parts.length; p++) {
            if (parts[p].startsWith('REF:')) refLabel = parts[p].substring(4);
            else if (parts[p].startsWith('STAT:')) status = parts[p].substring(5);
            else if (parts[p].startsWith('TYPE:')) type = parts[p].substring(5);
            else if (p === 4 && !parts[p].includes(':')) refLabel = parts[p];
          }

          channels.push({ label, iscale, rscale, unit, refLabel, status, type });
          i++;
        }
        continue; // Don't increment i again
      }

      i++;
    }

    // Default epoch length if not specified
    if (epochLength === 0) {
      epochLength = nSamples > 0 ? Math.min(nSamples, 1024 * 64) : 65536;
    }

    return { sampleRate, nChannels, nSamples, channels, epochLength, fileVersionMajor, fileVersionMinor };
  }

  private readTriggers(rootChunk: RiffChunk): AntTrigger[] {
    const evtChunk = this.riff.findSubchunk(rootChunk, FOURCC_evt);
    if (!evtChunk) return [];

    try {
      const evtData = this.riff.readChunkData(evtChunk);
      const evtText = evtData.toString('utf-8');
      const lines = evtText.split('\n');
      const triggers: AntTrigger[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith(';')) continue;

        // Format: sample_offset duration code [condition] [description]
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          const sampleIndex = parseInt(parts[0], 10);
          const duration = parseInt(parts[1], 10);
          const code = parts[2];
          if (!isNaN(sampleIndex)) {
            triggers.push({ code, sampleIndex, duration });
          }
        }
      }

      this.log.debug(`[ANT] Read ${triggers.length} triggers`);
      return triggers;
    } catch {
      this.log.warn('[ANT] Failed to read triggers');
      return [];
    }
  }
}

/**
 * SafeTensors file parser.
 *
 * Format (https://huggingface.co/docs/safetensors):
 *   Bytes 0-7:   uint64 LE — header size in bytes
 *   Bytes 8..8+N: JSON header — maps tensor names to {dtype, shape, data_offsets}
 *   Bytes 8+N..: raw tensor data (contiguous, aligned)
 *
 * The JSON header looks like:
 * {
 *   "__metadata__": { "format": "pt", ... },   // optional
 *   "model.embed_tokens.weight": {
 *     "dtype": "F16",
 *     "shape": [32000, 4096],
 *     "data_offsets": [0, 262144000]
 *   },
 *   ...
 * }
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafeTensorInfo {
  dtype: string;   // "F16", "BF16", "F32", "F64", "I8", "I16", "I32", "I64", "U8", "BOOL"
  shape: number[];
  data_offsets: [number, number]; // [start, end] relative to data section start
}

export interface SafeTensorsHeader {
  tensors: Map<string, SafeTensorInfo>;
  metadata: Record<string, string>;
  headerSize: number;
  dataOffset: number; // = 8 + headerSize
  fileSize: number;
}

// DType mapping to h5web-compatible types and TypedArray constructors
export const SAFETENSOR_DTYPE_MAP: Record<string, {
  class: string;
  size: number;
  signed?: boolean;
  bytesPerElement: number;
  typedArrayName: string;
}> = {
  'F16':  { class: 'Float', size: 16, bytesPerElement: 2, typedArrayName: 'Float32Array' }, // upcast
  'BF16': { class: 'Float', size: 16, bytesPerElement: 2, typedArrayName: 'Float32Array' }, // upcast
  'F32':  { class: 'Float', size: 32, bytesPerElement: 4, typedArrayName: 'Float32Array' },
  'F64':  { class: 'Float', size: 64, bytesPerElement: 8, typedArrayName: 'Float64Array' },
  'I8':   { class: 'Integer', size: 8, signed: true, bytesPerElement: 1, typedArrayName: 'Int8Array' },
  'I16':  { class: 'Integer', size: 16, signed: true, bytesPerElement: 2, typedArrayName: 'Int16Array' },
  'I32':  { class: 'Integer', size: 32, signed: true, bytesPerElement: 4, typedArrayName: 'Int32Array' },
  'I64':  { class: 'Integer', size: 64, signed: true, bytesPerElement: 8, typedArrayName: 'BigInt64Array' },
  'U8':   { class: 'Integer', size: 8, signed: false, bytesPerElement: 1, typedArrayName: 'Uint8Array' },
  'BOOL': { class: 'Boolean', size: 8, signed: false, bytesPerElement: 1, typedArrayName: 'Uint8Array' },
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the SafeTensors header without reading any tensor data.
 */
export function parseSafeTensorsHeader(filePath: string): SafeTensorsHeader {
  const fd = openSync(filePath, 'r');
  try {
    const fileSize = statSync(filePath).size;

    // Read header size (uint64 LE)
    const sizeBuf = Buffer.alloc(8);
    readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = Number(sizeBuf.readBigUInt64LE(0));

    if (headerSize > 100_000_000) { // Sanity check: 100MB header would be insane
      throw new Error(`SafeTensors header size too large: ${headerSize}`);
    }

    // Read header JSON
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, 8);
    const headerJson = JSON.parse(headerBuf.toString('utf-8'));

    const tensors = new Map<string, SafeTensorInfo>();
    let metadata: Record<string, string> = {};

    for (const [key, value] of Object.entries(headerJson)) {
      if (key === '__metadata__') {
        metadata = value as Record<string, string>;
      } else {
        const info = value as SafeTensorInfo;
        tensors.set(key, info);
      }
    }

    return {
      tensors,
      metadata,
      headerSize,
      dataOffset: 8 + headerSize,
      fileSize,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a specific tensor's raw data from a SafeTensors file.
 * Returns the data as a serialized typed array for postMessage transport.
 */
export function readSafeTensor(
  filePath: string,
  header: SafeTensorsHeader,
  tensorName: string,
): { data: unknown; dtype: string; shape: number[] } {
  const info = header.tensors.get(tensorName);
  if (!info) throw new Error(`Tensor not found: ${tensorName}`);

  const dtypeInfo = SAFETENSOR_DTYPE_MAP[info.dtype];
  if (!dtypeInfo) throw new Error(`Unsupported dtype: ${info.dtype}`);

  const [startOffset, endOffset] = info.data_offsets;
  const byteLength = endOffset - startOffset;
  const numElements = info.shape.reduce((a, b) => a * b, 1) || 1;

  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(byteLength);
    readSync(fd, buf, 0, byteLength, header.dataOffset + startOffset);

    // Convert to typed array
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    if (info.dtype === 'F16') {
      // IEEE 754 half-precision → float32 upcast
      const f32 = new Float32Array(numElements);
      const dv = new DataView(ab);
      for (let i = 0; i < numElements; i++) {
        f32[i] = float16ToFloat32(dv.getUint16(i * 2, true));
      }
      return {
        data: { __typedArray: true, type: 'Float32Array', data: Array.from(f32) },
        dtype: info.dtype,
        shape: info.shape,
      };
    }

    if (info.dtype === 'BF16') {
      // Brain float16 → float32 upcast
      const f32 = new Float32Array(numElements);
      const dv = new DataView(ab);
      for (let i = 0; i < numElements; i++) {
        // BF16 is just the upper 16 bits of float32
        const bits = dv.getUint16(i * 2, true);
        const f32Buf = new ArrayBuffer(4);
        new DataView(f32Buf).setUint32(0, bits << 16, false);
        f32[i] = new DataView(f32Buf).getFloat32(0, false);
      }
      return {
        data: { __typedArray: true, type: 'Float32Array', data: Array.from(f32) },
        dtype: info.dtype,
        shape: info.shape,
      };
    }

    if (info.dtype === 'I64') {
      const arr = new BigInt64Array(ab);
      return {
        data: { __typedArray: true, type: 'BigInt64Array', data: Array.from(arr, v => v.toString()) },
        dtype: info.dtype,
        shape: info.shape,
      };
    }

    // Standard types: direct typed array
    let values: number[];
    switch (info.dtype) {
      case 'F32': values = Array.from(new Float32Array(ab)); break;
      case 'F64': values = Array.from(new Float64Array(ab)); break;
      case 'I8':  values = Array.from(new Int8Array(ab)); break;
      case 'I16': values = Array.from(new Int16Array(ab)); break;
      case 'I32': values = Array.from(new Int32Array(ab)); break;
      case 'U8':  values = Array.from(new Uint8Array(ab)); break;
      case 'BOOL': values = Array.from(new Uint8Array(ab)); break;
      default: values = Array.from(new Float32Array(ab)); break;
    }

    return {
      data: { __typedArray: true, type: dtypeInfo.typedArrayName, data: values },
      dtype: info.dtype,
      shape: info.shape,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Check if a file is a SafeTensors file by reading the first bytes.
 */
export function isSafeTensorsFile(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(16);
      readSync(fd, buf, 0, 16, 0);
      // Header size should be reasonable, and byte 8 should be '{'
      const headerSize = Number(buf.readBigUInt64LE(0));
      return headerSize > 0 && headerSize < 100_000_000 && buf[8] === 0x7b; // '{'
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

// float16 → float32 conversion
function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * (frac / 1024) * Math.pow(2, -14);
  }
  if (exp === 0x1f) return frac ? NaN : (sign ? -Infinity : Infinity);
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * GGUF file parser.
 *
 * Format (https://github.com/ggerganov/ggml/blob/master/docs/gguf.md):
 *   Magic: "GGUF" (4 bytes)
 *   Version: uint32
 *   Tensor count: uint64
 *   Metadata KV count: uint64
 *   Metadata key-value pairs
 *   Tensor info array
 *   Alignment padding
 *   Tensor data
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// GGUF value types
// ---------------------------------------------------------------------------

export const GGUF_TYPE = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3,
  UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7,
  STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
} as const;

// GGML tensor types
export const GGML_TYPE_NAME: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1',
  6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS',
  19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS',
  24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64',
  28: 'F64', 29: 'IQ1_M',
  30: 'BF16',
};

// Bytes per element for each GGML type (for non-quantized types)
const GGML_TYPE_SIZE: Record<number, number> = {
  0: 4,   // F32
  1: 2,   // F16
  24: 1,  // I8
  25: 2,  // I16
  26: 4,  // I32
  27: 8,  // I64
  28: 8,  // F64
  30: 2,  // BF16
};

// Block sizes for quantized types
const GGML_QUANT_BLOCK_SIZE: Record<number, { blockSize: number; bytesPerBlock: number }> = {
  2:  { blockSize: 32, bytesPerBlock: 18 },   // Q4_0
  3:  { blockSize: 32, bytesPerBlock: 20 },   // Q4_1
  6:  { blockSize: 32, bytesPerBlock: 22 },   // Q5_0
  7:  { blockSize: 32, bytesPerBlock: 24 },   // Q5_1
  8:  { blockSize: 32, bytesPerBlock: 34 },   // Q8_0
  9:  { blockSize: 32, bytesPerBlock: 36 },   // Q8_1
  10: { blockSize: 256, bytesPerBlock: 84 },  // Q2_K
  11: { blockSize: 256, bytesPerBlock: 110 }, // Q3_K
  12: { blockSize: 256, bytesPerBlock: 144 }, // Q4_K
  13: { blockSize: 256, bytesPerBlock: 176 }, // Q5_K
  14: { blockSize: 256, bytesPerBlock: 210 }, // Q6_K
  15: { blockSize: 256, bytesPerBlock: 292 }, // Q8_K
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GGUFTensorInfo {
  name: string;
  shape: number[];   // n_dimensions dimensions
  type: number;      // GGML type enum
  typeName: string;
  offset: number;    // byte offset in data section
  numElements: number;
  sizeBytes: number;
}

export interface GGUFHeader {
  version: number;
  tensorCount: number;
  metadata: Record<string, unknown>;
  tensors: GGUFTensorInfo[];
  dataOffset: number; // file offset where tensor data begins
  fileSize: number;
}

// ---------------------------------------------------------------------------
// Reader helper
// ---------------------------------------------------------------------------

class BinaryReader {
  private fd: number;
  private pos: number;
  private buf: Buffer;

  constructor(fd: number, startPos: number) {
    this.fd = fd;
    this.pos = startPos;
    this.buf = Buffer.alloc(8); // reusable small buffer
  }

  private read(size: number): Buffer {
    if (size <= 8) {
      readSync(this.fd, this.buf, 0, size, this.pos);
      this.pos += size;
      return this.buf;
    }
    const b = Buffer.alloc(size);
    readSync(this.fd, b, 0, size, this.pos);
    this.pos += size;
    return b;
  }

  uint8(): number { return this.read(1).readUInt8(0); }
  int8(): number { return this.read(1).readInt8(0); }
  uint16(): number { return this.read(2).readUInt16LE(0); }
  int16(): number { return this.read(2).readInt16LE(0); }
  uint32(): number { return this.read(4).readUInt32LE(0); }
  int32(): number { return this.read(4).readInt32LE(0); }
  uint64(): bigint { return this.read(8).readBigUInt64LE(0); }
  int64(): bigint { return this.read(8).readBigInt64LE(0); }
  float32(): number { return this.read(4).readFloatLE(0); }
  float64(): number { return this.read(8).readDoubleLE(0); }
  bool(): boolean { return this.uint8() !== 0; }

  string(): string {
    const len = Number(this.uint64());
    if (len === 0) return '';
    if (len > 10_000_000) throw new Error(`String too long: ${len}`);
    const b = Buffer.alloc(len);
    readSync(this.fd, b, 0, len, this.pos);
    this.pos += len;
    return b.toString('utf-8');
  }

  readValue(type: number): unknown {
    switch (type) {
      case GGUF_TYPE.UINT8: return this.uint8();
      case GGUF_TYPE.INT8: return this.int8();
      case GGUF_TYPE.UINT16: return this.uint16();
      case GGUF_TYPE.INT16: return this.int16();
      case GGUF_TYPE.UINT32: return this.uint32();
      case GGUF_TYPE.INT32: return this.int32();
      case GGUF_TYPE.FLOAT32: return this.float32();
      case GGUF_TYPE.BOOL: return this.bool();
      case GGUF_TYPE.STRING: return this.string();
      case GGUF_TYPE.UINT64: return Number(this.uint64());
      case GGUF_TYPE.INT64: return Number(this.int64());
      case GGUF_TYPE.FLOAT64: return this.float64();
      case GGUF_TYPE.ARRAY: {
        const elemType = this.uint32();
        const count = Number(this.uint64());
        // Limit array size to prevent OOM
        if (count > 100_000) {
          // Skip the array data
          const arr = [`[array of ${count} elements, too large to display]`];
          for (let i = 0; i < count; i++) this.readValue(elemType);
          return arr;
        }
        const arr: unknown[] = [];
        for (let i = 0; i < count; i++) arr.push(this.readValue(elemType));
        return arr;
      }
      default:
        throw new Error(`Unknown GGUF value type: ${type}`);
    }
  }

  getPos(): number { return this.pos; }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseGGUFHeader(filePath: string): GGUFHeader {
  const fd = openSync(filePath, 'r');
  try {
    const fileSize = statSync(filePath).size;

    // Magic
    const magic = Buffer.alloc(4);
    readSync(fd, magic, 0, 4, 0);
    if (magic.toString('ascii') !== 'GGUF') {
      throw new Error('Not a GGUF file');
    }

    const reader = new BinaryReader(fd, 4);
    const version = reader.uint32();
    if (version < 2 || version > 3) {
      throw new Error(`Unsupported GGUF version: ${version}`);
    }

    const tensorCount = Number(reader.uint64());
    const metadataKvCount = Number(reader.uint64());

    // Read metadata
    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < metadataKvCount; i++) {
      const key = reader.string();
      const valueType = reader.uint32();
      const value = reader.readValue(valueType);
      metadata[key] = value;
    }

    // Read tensor infos
    const tensors: GGUFTensorInfo[] = [];
    for (let i = 0; i < tensorCount; i++) {
      const name = reader.string();
      const nDims = reader.uint32();
      const shape: number[] = [];
      for (let d = 0; d < nDims; d++) {
        shape.push(Number(reader.uint64()));
      }
      const type = reader.uint32();
      const offset = Number(reader.uint64());
      const typeName = GGML_TYPE_NAME[type] || `type_${type}`;

      // Calculate size
      const numElements = shape.reduce((a, b) => a * b, 1) || 1;
      let sizeBytes: number;
      if (GGML_TYPE_SIZE[type] !== undefined) {
        sizeBytes = numElements * GGML_TYPE_SIZE[type];
      } else if (GGML_QUANT_BLOCK_SIZE[type]) {
        const { blockSize, bytesPerBlock } = GGML_QUANT_BLOCK_SIZE[type];
        const numBlocks = Math.ceil(numElements / blockSize);
        sizeBytes = numBlocks * bytesPerBlock;
      } else {
        sizeBytes = 0; // Unknown quantization
      }

      tensors.push({ name, shape, type, typeName, offset, numElements, sizeBytes });
    }

    // Data starts after header, aligned to 32 bytes
    const headerEnd = reader.getPos();
    const alignment = 32;
    const dataOffset = Math.ceil(headerEnd / alignment) * alignment;

    return { version, tensorCount, metadata, tensors, dataOffset, fileSize };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a non-quantized tensor's data from a GGUF file.
 * For quantized tensors, returns null (they need dequantization which is complex).
 */
export function readGGUFTensor(
  filePath: string,
  header: GGUFHeader,
  tensorInfo: GGUFTensorInfo,
): { data: unknown; typeName: string } | null {
  const type = tensorInfo.type;
  const typeSize = GGML_TYPE_SIZE[type];

  // Only read non-quantized types
  if (typeSize === undefined) return null;

  const fd = openSync(filePath, 'r');
  try {
    const byteLen = tensorInfo.numElements * typeSize;
    const buf = Buffer.alloc(byteLen);
    readSync(fd, buf, 0, byteLen, header.dataOffset + tensorInfo.offset);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    let typedArrayName: string;
    let values: number[] | string[];

    switch (type) {
      case 0: // F32
        typedArrayName = 'Float32Array';
        values = Array.from(new Float32Array(ab));
        break;
      case 1: { // F16 → upcast to F32
        typedArrayName = 'Float32Array';
        const dv = new DataView(ab);
        const f32 = new Float32Array(tensorInfo.numElements);
        for (let i = 0; i < tensorInfo.numElements; i++) {
          const h = dv.getUint16(i * 2, true);
          const sign = (h >> 15) & 1;
          const exp = (h >> 10) & 0x1f;
          const frac = h & 0x3ff;
          if (exp === 0) f32[i] = (sign ? -1 : 1) * (frac / 1024) * Math.pow(2, -14);
          else if (exp === 0x1f) f32[i] = frac ? NaN : (sign ? -Infinity : Infinity);
          else f32[i] = (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
        }
        values = Array.from(f32);
        break;
      }
      case 30: { // BF16 → upcast to F32
        typedArrayName = 'Float32Array';
        const dv = new DataView(ab);
        const f32 = new Float32Array(tensorInfo.numElements);
        for (let i = 0; i < tensorInfo.numElements; i++) {
          const bits = dv.getUint16(i * 2, true);
          const f32Buf = new ArrayBuffer(4);
          new DataView(f32Buf).setUint32(0, bits << 16, false);
          f32[i] = new DataView(f32Buf).getFloat32(0, false);
        }
        values = Array.from(f32);
        break;
      }
      case 24: typedArrayName = 'Int8Array'; values = Array.from(new Int8Array(ab)); break;
      case 25: typedArrayName = 'Int16Array'; values = Array.from(new Int16Array(ab)); break;
      case 26: typedArrayName = 'Int32Array'; values = Array.from(new Int32Array(ab)); break;
      case 27: typedArrayName = 'BigInt64Array'; values = Array.from(new BigInt64Array(ab), v => v.toString()); break;
      case 28: typedArrayName = 'Float64Array'; values = Array.from(new Float64Array(ab)); break;
      default: return null;
    }

    return { data: { __typedArray: true, type: typedArrayName, data: values }, typeName: tensorInfo.typeName };
  } finally {
    closeSync(fd);
  }
}

export function isGGUFFile(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      readSync(fd, buf, 0, 4, 0);
      return buf.toString('ascii') === 'GGUF';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

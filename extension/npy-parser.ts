/**
 * NumPy .npy file parser for Node.js.
 *
 * Parses the NPY binary format (v1.0/v2.0/v3.0):
 *   - Magic: \x93NUMPY
 *   - Version + header length
 *   - Python dict header (descr, fortran_order, shape)
 *   - Raw array data
 *
 * Returns the parsed array as a serializable object matching
 * the h5-service's value serialization format.
 */

export interface NpyResult {
  /** Parsed shape */
  shape: number[];
  /** h5web-compatible dtype descriptor */
  dtype: unknown;
  /** Serialized value (typed array format for postMessage) */
  value: unknown;
  /** Original numpy dtype string */
  npyDtype: string;
}

const DTYPE_MAP: Record<string, { class: string; signed?: boolean; size: number; typedArray: string; bytes: number }> = {
  'f2': { class: 'Float', size: 16, typedArray: 'Float32Array', bytes: 2 },  // f16 → upcast to f32
  'f4': { class: 'Float', size: 32, typedArray: 'Float32Array', bytes: 4 },
  'f8': { class: 'Float', size: 64, typedArray: 'Float64Array', bytes: 8 },
  'i1': { class: 'Integer', signed: true, size: 8, typedArray: 'Int8Array', bytes: 1 },
  'i2': { class: 'Integer', signed: true, size: 16, typedArray: 'Int16Array', bytes: 2 },
  'i4': { class: 'Integer', signed: true, size: 32, typedArray: 'Int32Array', bytes: 4 },
  'i8': { class: 'Integer', signed: true, size: 64, typedArray: 'BigInt64Array', bytes: 8 },
  'u1': { class: 'Integer', signed: false, size: 8, typedArray: 'Uint8Array', bytes: 1 },
  'u2': { class: 'Integer', signed: false, size: 16, typedArray: 'Uint16Array', bytes: 2 },
  'u4': { class: 'Integer', signed: false, size: 32, typedArray: 'Uint32Array', bytes: 4 },
  'u8': { class: 'Integer', signed: false, size: 64, typedArray: 'BigUint64Array', bytes: 8 },
  'b1': { class: 'Boolean', signed: false, size: 8, typedArray: 'Uint8Array', bytes: 1 },
};

/**
 * Parse a .npy binary buffer.
 */
export function parseNpy(buffer: Buffer): NpyResult {
  // 1. Verify magic
  if (
    buffer[0] !== 0x93 ||
    buffer[1] !== 0x4e || // N
    buffer[2] !== 0x55 || // U
    buffer[3] !== 0x4d || // M
    buffer[4] !== 0x50 || // P
    buffer[5] !== 0x59    // Y
  ) {
    throw new Error('Not a valid .npy file (bad magic bytes)');
  }

  // 2. Version
  const major = buffer[0x06];

  // 3. Header length and data offset
  let headerLen: number;
  let headerStart: number;

  if (major === 1) {
    headerLen = buffer.readUInt16LE(8);
    headerStart = 10;
  } else if (major >= 2) {
    headerLen = buffer.readUInt32LE(8);
    headerStart = 12;
  } else {
    throw new Error(`Unsupported .npy version: ${major}`);
  }

  const dataOffset = headerStart + headerLen;

  // 4. Parse header (Python dict literal)
  const headerStr = buffer.toString('utf-8', headerStart, headerStart + headerLen).trim();

  const descrMatch = headerStr.match(/'descr'\s*:\s*'([^']+)'/);
  const fortranMatch = headerStr.match(/'fortran_order'\s*:\s*(True|False)/);
  const shapeMatch = headerStr.match(/'shape'\s*:\s*\(([^)]*)\)/);

  if (!descrMatch) throw new Error(`Failed to parse .npy header descr: ${headerStr}`);

  const descr = descrMatch[1];
  const fortranOrder = fortranMatch ? fortranMatch[1] === 'True' : false;
  const shape = shapeMatch
    ? shapeMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0).map(Number)
    : [];

  // 5. Resolve dtype
  const byteOrder = descr[0]; // '<', '>', '|', '='
  const typeKey = descr.slice(1); // 'f4', 'i2', etc.

  const dtypeInfo = DTYPE_MAP[typeKey];
  if (!dtypeInfo) {
    // Unsupported dtype — return as raw uint8
    const totalBytes = buffer.length - dataOffset;
    return {
      shape: [totalBytes],
      dtype: { class: 'Integer', signed: false, size: 8, endianness: 'little-endian' },
      value: {
        __typedArray: true,
        type: 'Uint8Array',
        data: Array.from(buffer.subarray(dataOffset)),
      },
      npyDtype: descr,
    };
  }

  // 6. Calculate total elements
  const numElements = shape.length === 0 ? 1 : shape.reduce((a, b) => a * b, 1);
  const needsSwap = byteOrder === '>' && dtypeInfo.bytes > 1;

  // 7. Extract data region
  const dataBuf = Buffer.from(buffer.buffer, buffer.byteOffset + dataOffset, numElements * dtypeInfo.bytes);

  // Byte-swap if big-endian
  if (needsSwap) {
    const bs = dtypeInfo.bytes;
    for (let i = 0; i < dataBuf.length; i += bs) {
      for (let j = 0; j < bs / 2; j++) {
        const tmp = dataBuf[i + j];
        dataBuf[i + j] = dataBuf[i + bs - 1 - j];
        dataBuf[i + bs - 1 - j] = tmp;
      }
    }
  }

  // 8. Create typed array and serialize
  const isLE = byteOrder !== '>';
  const endianness = isLE ? 'little-endian' : 'big-endian';
  let data: number[] | string[];
  let typedArrayType = dtypeInfo.typedArray;

  if (typeKey === 'f2') {
    // float16 → upcast to float32
    const f32 = new Float32Array(numElements);
    for (let i = 0; i < numElements; i++) {
      f32[i] = float16ToFloat32(dataBuf.readUInt16LE(i * 2));
    }
    data = Array.from(f32);
    typedArrayType = 'Float32Array';
  } else if (typeKey === 'i8' || typeKey === 'u8') {
    // BigInt types → serialize as strings
    const arr: string[] = [];
    for (let i = 0; i < numElements; i++) {
      if (typeKey === 'i8') {
        arr.push(dataBuf.readBigInt64LE(i * 8).toString());
      } else {
        arr.push(dataBuf.readBigUInt64LE(i * 8).toString());
      }
    }
    data = arr;
  } else {
    // Standard numeric types
    const ab = dataBuf.buffer.slice(dataBuf.byteOffset, dataBuf.byteOffset + dataBuf.byteLength);
    let typedArr: ArrayLike<number>;
    switch (typeKey) {
      case 'f4': typedArr = new Float32Array(ab); break;
      case 'f8': typedArr = new Float64Array(ab); break;
      case 'i1': typedArr = new Int8Array(ab); break;
      case 'i2': typedArr = new Int16Array(ab); break;
      case 'i4': typedArr = new Int32Array(ab); break;
      case 'u1': typedArr = new Uint8Array(ab); break;
      case 'u2': typedArr = new Uint16Array(ab); break;
      case 'u4': typedArr = new Uint32Array(ab); break;
      case 'b1': typedArr = new Uint8Array(ab); break;
      default: typedArr = new Float64Array(ab); break;
    }
    data = Array.from(typedArr);
  }

  // Build h5web dtype
  const dtype: Record<string, unknown> = {
    class: dtypeInfo.class,
    size: dtypeInfo.size,
    endianness,
  };
  if (dtypeInfo.signed !== undefined) {
    dtype.signed = dtypeInfo.signed;
  }

  return {
    shape: shape.length === 0 ? [] : shape,
    dtype,
    value: {
      __typedArray: true,
      type: typedArrayType,
      data,
    },
    npyDtype: descr,
  };
}

/**
 * Convert IEEE 754 half-precision float16 to float32.
 */
function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;

  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    // Subnormal
    let f = frac / 1024;
    return (sign ? -1 : 1) * f * Math.pow(2, -14);
  }
  if (exp === 0x1f) {
    return frac ? NaN : (sign ? -Infinity : Infinity);
  }

  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Check if a buffer starts with the NPY magic bytes.
 */
export function isNpyBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x93 &&
    buffer[1] === 0x4e &&
    buffer[2] === 0x55 &&
    buffer[3] === 0x4d &&
    buffer[4] === 0x50 &&
    buffer[5] === 0x59
  );
}

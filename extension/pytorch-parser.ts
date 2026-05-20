/**
 * PyTorch checkpoint parser.
 *
 * PyTorch's torch.save() produces a ZIP file containing:
 *   {prefix}/data.pkl     — pickle-serialized Python object (dict, OrderedDict, etc.)
 *   {prefix}/data/{0,1,2} — raw tensor storage data
 *   {prefix}/version      — serialization version (usually "3")
 *   {prefix}/byteorder    — "little"
 *
 * This parser implements:
 *   1. A minimal ZIP central directory reader (with ZIP64 support) for random access
 *   2. A minimal pickle VM that handles the opcodes used by PyTorch's serialization
 *   3. On-demand tensor storage reading via positioned reads (pread)
 *
 * It does NOT execute arbitrary Python code — only recognizes known
 * PyTorch patterns like torch.FloatStorage and _rebuild_tensor_v2.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TensorRef {
  __tensorRef: true;
  storageType: string; // "FloatStorage", "BFloat16Storage", etc.
  storageKey: string;  // "0", "1", "2", ...
  device: string;      // "cpu", "cuda:0", etc.
  numElements: number;
  storageOffset: number; // offset within storage in elements
  shape: number[];
  stride: number[];
}

export interface ZipEntry {
  fileName: string;
  compressionMethod: number;  // 0=STORED, 8=DEFLATE
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface PyTorchCheckpointHeader {
  filePath: string;
  prefix: string;
  data: unknown;  // The unpickled Python object (dict, OrderedDict, etc.)
  storageEntries: Map<string, ZipEntry>;  // storage key → ZIP entry
}

// ---------------------------------------------------------------------------
// Storage type → bytes per element
// ---------------------------------------------------------------------------

const STORAGE_BYTES: Record<string, number> = {
  'FloatStorage': 4,
  'DoubleStorage': 8,
  'HalfStorage': 2,
  'BFloat16Storage': 2,
  'ByteStorage': 1,
  'CharStorage': 1,
  'ShortStorage': 2,
  'IntStorage': 4,
  'LongStorage': 8,
  'BoolStorage': 1,
  'ComplexFloatStorage': 8,
  'ComplexDoubleStorage': 16,
};

const STORAGE_DTYPE: Record<string, string> = {
  'FloatStorage': 'float32',
  'DoubleStorage': 'float64',
  'HalfStorage': 'float16',
  'BFloat16Storage': 'bfloat16',
  'ByteStorage': 'uint8',
  'CharStorage': 'int8',
  'ShortStorage': 'int16',
  'IntStorage': 'int32',
  'LongStorage': 'int64',
  'BoolStorage': 'bool',
};

export { STORAGE_BYTES, STORAGE_DTYPE };

// ---------------------------------------------------------------------------
// ZIP central directory parser (with ZIP64 support)
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CD_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

function parseZipCentralDirectory(filePath: string): ZipEntry[] {
  const fd = openSync(filePath, 'r');
  try {
    const fileSize = statSync(filePath).size;

    // Read the tail of the file to find the EOCD record
    const tailSize = Math.min(65558, fileSize);
    const tailBuf = Buffer.alloc(tailSize);
    readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize);

    // Scan backwards for EOCD signature
    let eocdPos = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tailBuf.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos === -1) {
      throw new Error('Not a valid ZIP file: End of Central Directory not found');
    }

    // Parse EOCD
    let cdSize = tailBuf.readUInt32LE(eocdPos + 12);
    let cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

    // Check for ZIP64
    if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
      // Look for ZIP64 EOCD Locator before the EOCD
      const eocdAbsolutePos = fileSize - tailSize + eocdPos;
      if (eocdAbsolutePos >= 20) {
        const locatorBuf = Buffer.alloc(20);
        readSync(fd, locatorBuf, 0, 20, eocdAbsolutePos - 20);
        if (locatorBuf.readUInt32LE(0) === EOCD64_LOCATOR_SIGNATURE) {
          // Read ZIP64 EOCD offset (8 bytes at position 8 in locator)
          const eocd64Offset = Number(locatorBuf.readBigUInt64LE(8));

          // Read ZIP64 EOCD Record
          const eocd64Buf = Buffer.alloc(56);
          readSync(fd, eocd64Buf, 0, 56, eocd64Offset);
          if (eocd64Buf.readUInt32LE(0) === EOCD64_SIGNATURE) {
            cdSize = Number(eocd64Buf.readBigUInt64LE(40));
            cdOffset = Number(eocd64Buf.readBigUInt64LE(48));
          }
        }
      }
    }

    // Read the entire Central Directory
    const cdBuf = Buffer.alloc(cdSize);
    readSync(fd, cdBuf, 0, cdSize, cdOffset);

    // Parse Central Directory entries
    const entries: ZipEntry[] = [];
    let pos = 0;

    while (pos + 46 <= cdSize) {
      if (cdBuf.readUInt32LE(pos) !== CD_ENTRY_SIGNATURE) break;

      const compressionMethod = cdBuf.readUInt16LE(pos + 10);
      let compressedSize = cdBuf.readUInt32LE(pos + 20);
      let uncompressedSize = cdBuf.readUInt32LE(pos + 24);
      const fileNameLen = cdBuf.readUInt16LE(pos + 28);
      const extraFieldLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      let localHeaderOffset = cdBuf.readUInt32LE(pos + 42);

      const fileName = cdBuf.toString('utf-8', pos + 46, pos + 46 + fileNameLen);

      // Parse ZIP64 extended information extra field if needed
      if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
        const extraStart = pos + 46 + fileNameLen;
        const extraEnd = extraStart + extraFieldLen;
        let ePos = extraStart;
        while (ePos + 4 <= extraEnd) {
          const headerId = cdBuf.readUInt16LE(ePos);
          const dataSize = cdBuf.readUInt16LE(ePos + 2);
          if (headerId === ZIP64_EXTRA_FIELD_ID) {
            let fieldPos = ePos + 4;
            if (uncompressedSize === 0xFFFFFFFF) {
              uncompressedSize = Number(cdBuf.readBigUInt64LE(fieldPos));
              fieldPos += 8;
            }
            if (compressedSize === 0xFFFFFFFF) {
              compressedSize = Number(cdBuf.readBigUInt64LE(fieldPos));
              fieldPos += 8;
            }
            if (localHeaderOffset === 0xFFFFFFFF) {
              localHeaderOffset = Number(cdBuf.readBigUInt64LE(fieldPos));
            }
            break;
          }
          ePos += 4 + dataSize;
        }
      }

      entries.push({ fileName, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
      pos += 46 + fileNameLen + extraFieldLen + commentLen;
    }

    return entries;
  } finally {
    closeSync(fd);
  }
}

function readZipEntry(fd: number, entry: ZipEntry): Buffer {
  // Read local file header to determine data offset
  const lhBuf = Buffer.alloc(30);
  readSync(fd, lhBuf, 0, 30, entry.localHeaderOffset);

  if (lhBuf.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error('Corrupt ZIP: invalid local file header signature');
  }

  const fileNameLen = lhBuf.readUInt16LE(26);
  const extraFieldLen = lhBuf.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLen + extraFieldLen;

  if (entry.compressionMethod === 0) {
    // STORED: read raw bytes directly
    const buf = Buffer.alloc(entry.uncompressedSize);
    readSync(fd, buf, 0, entry.uncompressedSize, dataStart);
    return buf;
  }

  if (entry.compressionMethod === 8) {
    // DEFLATE: read compressed data, then inflate
    const compressed = Buffer.alloc(entry.compressedSize);
    readSync(fd, compressed, 0, entry.compressedSize, dataStart);
    return inflateRawSync(compressed);
  }

  throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
}

// ---------------------------------------------------------------------------
// Public API: Parse header (metadata only, no tensor data)
// ---------------------------------------------------------------------------

export function parsePyTorchHeader(filePath: string): PyTorchCheckpointHeader {
  const entries = parseZipCentralDirectory(filePath);

  // Find data.pkl to determine prefix
  const pklEntry = entries.find(e => e.fileName.endsWith('/data.pkl'));
  if (!pklEntry) {
    throw new Error('Missing data.pkl in PyTorch checkpoint');
  }

  const prefix = pklEntry.fileName.split('/')[0] || '';

  // Extract and parse data.pkl
  const fd = openSync(filePath, 'r');
  let data: unknown;
  try {
    const pklBuf = readZipEntry(fd, pklEntry);
    data = unpickle(pklBuf);
  } finally {
    closeSync(fd);
  }

  // Build storage entries map: "0" → ZipEntry, "1" → ZipEntry, etc.
  // PyTorch uses "data/" (older) or ".data/" (newer, 2.x+) for tensor storage
  const storageEntries = new Map<string, ZipEntry>();
  const dataPrefixes = prefix
    ? [`${prefix}/data/`, `${prefix}/.data/`]
    : ['data/', '.data/'];
  for (const entry of entries) {
    for (const dp of dataPrefixes) {
      if (entry.fileName.startsWith(dp) && entry.fileName.length > dp.length) {
        const key = entry.fileName.slice(dp.length);
        if (key && key !== 'serialization_id') {
          storageEntries.set(key, entry);
        }
        break;
      }
    }
  }

  return { filePath, prefix, data, storageEntries };
}

// ---------------------------------------------------------------------------
// Public API: Read tensor storage on demand
// ---------------------------------------------------------------------------

export function readPyTorchStorage(
  filePath: string,
  header: PyTorchCheckpointHeader,
  storageKey: string,
  byteOffset: number,
  byteLength: number,
): Buffer {
  const entry = header.storageEntries.get(storageKey);
  if (!entry) {
    throw new Error(`Tensor storage "${storageKey}" not found in checkpoint`);
  }

  const fd = openSync(filePath, 'r');
  try {
    // Read local file header to determine data start
    const lhBuf = Buffer.alloc(30);
    readSync(fd, lhBuf, 0, 30, entry.localHeaderOffset);

    if (lhBuf.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error('Corrupt ZIP: invalid local file header signature');
    }

    const fileNameLen = lhBuf.readUInt16LE(26);
    const extraFieldLen = lhBuf.readUInt16LE(28);
    const dataStart = entry.localHeaderOffset + 30 + fileNameLen + extraFieldLen;

    if (entry.compressionMethod === 0) {
      // STORED: direct random-access read of just the needed bytes
      const buf = Buffer.alloc(byteLength);
      readSync(fd, buf, 0, byteLength, dataStart + byteOffset);
      return buf;
    }

    // DEFLATE: must decompress entire entry, then slice
    const compressed = Buffer.alloc(entry.compressedSize);
    readSync(fd, compressed, 0, entry.compressedSize, dataStart);
    const full = inflateRawSync(compressed);
    return full.subarray(byteOffset, byteOffset + byteLength) as Buffer;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Pickle opcodes (protocol 2, subset used by PyTorch)
// ---------------------------------------------------------------------------

const OP = {
  PROTO: 0x80,
  STOP: 0x2e,         // .
  MARK: 0x28,         // (
  POP: 0x30,          // 0
  POP_MARK: 0x31,     // 1
  DUP: 0x32,          // 2
  EMPTY_DICT: 0x7d,   // }
  EMPTY_LIST: 0x5d,   // ]
  EMPTY_TUPLE: 0x29,  // )
  SETITEM: 0x73,      // s
  SETITEMS: 0x75,     // u
  APPEND: 0x61,       // a
  APPENDS: 0x65,      // e
  DICT: 0x64,         // d
  LIST: 0x6c,         // l
  TUPLE: 0x74,        // t
  TUPLE1: 0x85,
  TUPLE2: 0x86,
  TUPLE3: 0x87,
  NONE: 0x4e,         // N
  NEWTRUE: 0x88,
  NEWFALSE: 0x89,
  INT: 0x49,          // I
  BININT: 0x4a,       // J
  BININT1: 0x4b,      // K
  BININT2: 0x4d,      // M
  LONG1: 0x8a,
  FLOAT: 0x46,        // F
  BINFLOAT: 0x47,     // G
  SHORT_BINSTRING: 0x55, // U
  BINSTRING: 0x54,    // T
  SHORT_BINUNICODE: 0x8c,
  BINUNICODE: 0x58,   // X
  BINBYTES: 0x42,     // B
  SHORT_BINBYTES: 0x43, // C
  GLOBAL: 0x63,       // c
  STACK_GLOBAL: 0x93,
  REDUCE: 0x52,       // R
  BUILD: 0x62,        // b
  NEWOBJ: 0x81,
  BINGET: 0x68,       // h
  LONG_BINGET: 0x6a,  // j
  BINPUT: 0x71,       // q
  LONG_BINPUT: 0x72,  // r
  MEMOIZE: 0x94,
  FRAME: 0x95,
  BINPERSID: 0x51,    // Q
  EMPTY_SET: 0x8f,
  ADDITEMS: 0x90,
  FROZENSET: 0x91,
  SHORT_BINBYTES_8: 0x8e,
} as const;

const MARK = Symbol('MARK');

// ---------------------------------------------------------------------------
// Mini pickle VM
// ---------------------------------------------------------------------------

export function unpickle(buf: Buffer): unknown {
  const stack: unknown[] = [];
  const memo: Map<number, unknown> = new Map();
  let pos = 0;
  let memoIdx = 0;

  function read(n: number): Buffer {
    const slice = buf.subarray(pos, pos + n);
    pos += n;
    return slice;
  }
  function readUint8(): number { return buf[pos++]; }
  function readUint16(): number { const v = buf.readUInt16LE(pos); pos += 2; return v; }
  function readInt32(): number { const v = buf.readInt32LE(pos); pos += 4; return v; }
  function readUint32(): number { const v = buf.readUInt32LE(pos); pos += 4; return v; }
  function readFloat64(): number { const v = buf.readDoubleLE(pos); pos += 8; return v; }
  function readLine(): string {
    let end = pos;
    while (end < buf.length && buf[end] !== 0x0a) end++;
    const line = buf.toString('ascii', pos, end);
    pos = end + 1;
    return line;
  }

  function popMark(): unknown[] {
    const items: unknown[] = [];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === MARK) { stack.pop(); break; }
      items.unshift(stack.pop()!);
    }
    return items;
  }

  while (pos < buf.length) {
    const opcode = readUint8();

    switch (opcode) {
      case OP.PROTO: pos++; break; // Skip protocol version byte
      case OP.FRAME: pos += 8; break; // Skip frame length (uint64)
      case OP.STOP: return stack[stack.length - 1];
      case OP.MARK: stack.push(MARK); break;
      case OP.POP: stack.pop(); break;
      case OP.POP_MARK: popMark(); break;
      case OP.DUP: stack.push(stack[stack.length - 1]); break;

      // None / Bool
      case OP.NONE: stack.push(null); break;
      case OP.NEWTRUE: stack.push(true); break;
      case OP.NEWFALSE: stack.push(false); break;

      // Integers
      case OP.INT: {
        const line = readLine();
        if (line === '00') stack.push(false);
        else if (line === '01') stack.push(true);
        else stack.push(parseInt(line, 10));
        break;
      }
      case OP.BININT: stack.push(readInt32()); break;
      case OP.BININT1: stack.push(readUint8()); break;
      case OP.BININT2: stack.push(readUint16()); break;
      case OP.LONG1: {
        const n = readUint8();
        if (n === 0) { stack.push(0); break; }
        const bytes = read(n);
        let val = 0n;
        for (let i = n - 1; i >= 0; i--) val = (val << 8n) | BigInt(bytes[i]);
        if (bytes[n - 1] & 0x80) val -= (1n << BigInt(n * 8));
        stack.push(Number(val));
        break;
      }

      // Floats
      case OP.FLOAT: stack.push(parseFloat(readLine())); break;
      case OP.BINFLOAT: stack.push(readFloat64()); break;

      // Strings
      case OP.SHORT_BINSTRING: { const n = readUint8(); stack.push(read(n).toString('ascii')); break; }
      case OP.BINSTRING: { const n = readInt32(); stack.push(read(n).toString('ascii')); break; }
      case OP.SHORT_BINUNICODE: { const n = readUint8(); stack.push(read(n).toString('utf-8')); break; }
      case OP.BINUNICODE: { const n = readUint32(); stack.push(read(n).toString('utf-8')); break; }
      case OP.BINBYTES: { const n = readUint32(); stack.push(read(n)); break; }
      case OP.SHORT_BINBYTES: { const n = readUint8(); stack.push(read(n)); break; }

      // Containers
      case OP.EMPTY_DICT: stack.push({}); break;
      case OP.EMPTY_LIST: stack.push([]); break;
      case OP.EMPTY_TUPLE: stack.push([]); break;
      case OP.EMPTY_SET: stack.push(new Set()); break;

      case OP.DICT: {
        const items = popMark();
        const d: Record<string, unknown> = {};
        for (let i = 0; i < items.length; i += 2) d[String(items[i])] = items[i + 1];
        stack.push(d);
        break;
      }
      case OP.LIST: stack.push(popMark()); break;
      case OP.TUPLE: stack.push(popMark()); break;
      case OP.TUPLE1: { const a = stack.pop(); stack.push([a]); break; }
      case OP.TUPLE2: { const b = stack.pop(); const a = stack.pop(); stack.push([a, b]); break; }
      case OP.TUPLE3: { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); stack.push([a, b, c]); break; }

      case OP.SETITEM: {
        const val = stack.pop();
        const key = stack.pop();
        const dict = stack[stack.length - 1] as Record<string, unknown>;
        dict[String(key)] = val;
        break;
      }
      case OP.SETITEMS: {
        const items = popMark();
        const dict = stack[stack.length - 1] as Record<string, unknown>;
        for (let i = 0; i < items.length; i += 2) dict[String(items[i])] = items[i + 1];
        break;
      }
      case OP.APPEND: {
        const val = stack.pop();
        (stack[stack.length - 1] as unknown[]).push(val);
        break;
      }
      case OP.APPENDS: {
        const items = popMark();
        const list = stack[stack.length - 1] as unknown[];
        list.push(...items);
        break;
      }
      case OP.ADDITEMS: {
        const items = popMark();
        const set = stack[stack.length - 1] as Set<unknown>;
        for (const item of items) set.add(item);
        break;
      }
      case OP.FROZENSET: {
        const items = popMark();
        stack.push(new Set(items));
        break;
      }

      // Global (class references)
      case OP.GLOBAL: {
        const module = readLine();
        const name = readLine();
        stack.push({ __global: true, module, name });
        break;
      }
      case OP.STACK_GLOBAL: {
        const name = stack.pop() as string;
        const module = stack.pop() as string;
        stack.push({ __global: true, module, name });
        break;
      }

      // Object construction
      case OP.REDUCE: {
        const args = stack.pop() as unknown[];
        const callable = stack.pop() as { __global?: boolean; module?: string; name?: string };

        if (callable?.__global && callable.module === 'torch' && callable.name?.endsWith('Storage')) {
          // torch.FloatStorage(args) — create a storage reference
          stack.push({ __storage: true, type: callable.name, args });
        } else if (callable?.__global && callable.name === '_rebuild_tensor_v2') {
          // torch._utils._rebuild_tensor_v2(storage, offset, shape, stride)
          const [storage, offset, shape, stride] = args as [unknown, number, number[], number[]];
          const sto = storage as { __storage?: boolean; type?: string; args?: unknown[] };
          if (sto?.__storage) {
            const stoArgs = sto.args as unknown[];
            // stoArgs = [storageType, key, device, numElements]
            const storageKey = String(stoArgs[1] ?? '');
            const device = String(stoArgs[2] ?? 'cpu');
            const numElements = Number(stoArgs[3] ?? 0);
            const ref: TensorRef = {
              __tensorRef: true,
              storageType: String(sto.type),
              storageKey,
              device,
              numElements,
              storageOffset: Number(offset) || 0,
              shape: shape || [],
              stride: stride || [],
            };
            stack.push(ref);
          } else {
            stack.push({ __reducedTensor: true, storage, shape, stride });
          }
        } else if (callable?.__global && callable.module === 'collections' && callable.name === 'OrderedDict') {
          // collections.OrderedDict() → empty dict
          stack.push({});
        } else {
          // Unknown callable — store as opaque
          stack.push({ __reduced: true, callable, args });
        }
        break;
      }

      case OP.NEWOBJ: {
        const args = stack.pop();
        const cls = stack.pop();
        stack.push({ __newobj: true, cls, args });
        break;
      }

      case OP.BUILD: {
        const state = stack.pop();
        const obj = stack[stack.length - 1];
        // BUILD updates the object's state
        if (obj && typeof obj === 'object' && state && typeof state === 'object' && !Array.isArray(state)) {
          Object.assign(obj, state);
        }
        break;
      }

      // Memo
      case OP.BINPUT: { const idx = readUint8(); memo.set(idx, stack[stack.length - 1]); break; }
      case OP.LONG_BINPUT: { const idx = readUint32(); memo.set(idx, stack[stack.length - 1]); break; }
      case OP.BINGET: { const idx = readUint8(); stack.push(memo.get(idx)); break; }
      case OP.LONG_BINGET: { const idx = readUint32(); stack.push(memo.get(idx)); break; }
      case OP.MEMOIZE: { memo.set(memoIdx++, stack[stack.length - 1]); break; }

      // Persistent ID (used by newer PyTorch)
      case OP.BINPERSID: {
        const pid = stack.pop();
        // PyTorch persistent_load: pid is a tuple like ("storage", storage_type, key, device, numel)
        if (Array.isArray(pid) && pid[0] === 'storage') {
          stack.push({
            __storage: true,
            type: pid[1]?.__global ? pid[1].name : String(pid[1]),
            args: [null, pid[2], pid[3], pid[4]],
          });
        } else {
          stack.push({ __persid: true, id: pid });
        }
        break;
      }

      default:
        // Skip unknown opcodes gracefully
        break;
    }
  }

  return stack.length > 0 ? stack[stack.length - 1] : null;
}

// ---------------------------------------------------------------------------
// isPyTorchFile — quick magic-byte check
// ---------------------------------------------------------------------------

export function isPyTorchFile(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    try {
      const hdr = Buffer.alloc(4);
      readSync(fd, hdr, 0, 4, 0);
      return hdr[0] === 0x50 && hdr[1] === 0x4b && hdr[2] === 0x03 && hdr[3] === 0x04; // PK\x03\x04
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

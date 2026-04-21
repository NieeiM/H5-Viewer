/**
 * PyTorch checkpoint parser.
 *
 * PyTorch's torch.save() produces a ZIP file containing:
 *   {prefix}/data.pkl     — pickle-serialized Python object (dict, OrderedDict, etc.)
 *   {prefix}/data/{0,1,2} — raw tensor storage data
 *   {prefix}/version      — serialization version (usually "3")
 *   {prefix}/byteorder    — "little"
 *
 * This parser implements a minimal pickle VM that handles the opcodes
 * used by PyTorch's serialization, plus ZIP extraction via Node.js zlib.
 *
 * It does NOT execute arbitrary Python code — only recognizes known
 * PyTorch patterns like torch.FloatStorage and _rebuild_tensor_v2.
 */

import { readFileSync, openSync, readSync, closeSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TensorRef {
  __tensorRef: true;
  storageType: string; // "FloatStorage", "BFloat16Storage", etc.
  storageKey: string;  // "0", "1", "2", ...
  device: string;      // "cpu", "cuda:0", etc.
  numElements: number;
  shape: number[];
  stride: number[];
}

export interface ParsedCheckpoint {
  data: unknown;              // The deserialized Python object (dict, list, etc.)
  tensorStorages: Map<string, Buffer>; // key → raw bytes
  prefix: string;             // ZIP prefix (e.g. "optimizer")
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
// ZIP extraction + checkpoint parsing
// ---------------------------------------------------------------------------

export function parsePyTorchCheckpoint(filePath: string): ParsedCheckpoint {
  // Extract ZIP to temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), 'pytorch-'));

  try {
    execSync(`unzip -o -q "${filePath}" -d "${tmpDir}"`, { timeout: 30000 });

    // Find the prefix (first directory inside ZIP)
    const entries = readdirSync(tmpDir);
    const prefix = entries[0] || '';
    const baseDir = join(tmpDir, prefix);

    // Read and parse data.pkl
    const pklPath = join(baseDir, 'data.pkl');
    if (!existsSync(pklPath)) {
      throw new Error('Missing data.pkl in PyTorch checkpoint');
    }
    const pklBuf = readFileSync(pklPath);
    const data = unpickle(pklBuf);

    // Read tensor storage files
    const tensorStorages = new Map<string, Buffer>();
    const dataDir = join(baseDir, 'data');
    if (existsSync(dataDir)) {
      for (const name of readdirSync(dataDir)) {
        if (name === 'serialization_id') continue;
        tensorStorages.set(name, readFileSync(join(dataDir, name)));
      }
    }

    return { data, tensorStorages, prefix };
  } finally {
    // Cleanup temp dir
    try { rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
  }
}

/**
 * Check if a file is a PyTorch checkpoint (ZIP with data.pkl inside).
 */
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

/**
 * PyTorch checkpoint reading service.
 *
 * Parses torch.save() ZIP files, builds a virtual HDF5-like tree
 * from the deserialized Python dict structure.
 */

import { statSync } from 'node:fs';
import type { Logger } from './h5-service.js';
import {
  parsePyTorchCheckpoint, type TensorRef, type ParsedCheckpoint,
  STORAGE_BYTES, STORAGE_DTYPE,
} from './pytorch-parser.js';

const DTypeClass = {
  Float: 'Float', Integer: 'Integer', String: 'String', Bool: 'Boolean', Unknown: 'Unknown',
} as const;

const EntityKind = { Group: 'group', Dataset: 'dataset' } as const;

interface VNode {
  name: string;
  path: string;
  kind: string;
  children?: VNode[];
  shape?: number[];
  type?: unknown;
  value?: unknown;
  attributes?: Array<{ name: string; shape: number[] | null; type: unknown }>;
  _tensorRef?: TensorRef;
  [key: string]: unknown;
}

const noopLogger: Logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

const DTYPE_TO_H5: Record<string, unknown> = {
  'float32': { class: DTypeClass.Float, size: 32, endianness: 'little-endian' },
  'float64': { class: DTypeClass.Float, size: 64, endianness: 'little-endian' },
  'float16': { class: DTypeClass.Float, size: 16, endianness: 'little-endian' },
  'bfloat16': { class: DTypeClass.Float, size: 16, endianness: 'little-endian' },
  'uint8': { class: DTypeClass.Integer, signed: false, size: 8, endianness: 'little-endian' },
  'int8': { class: DTypeClass.Integer, signed: true, size: 8, endianness: 'little-endian' },
  'int16': { class: DTypeClass.Integer, signed: true, size: 16, endianness: 'little-endian' },
  'int32': { class: DTypeClass.Integer, signed: true, size: 32, endianness: 'little-endian' },
  'int64': { class: DTypeClass.Integer, signed: true, size: 64, endianness: 'little-endian' },
  'bool': { class: DTypeClass.Bool, size: 8, endianness: 'little-endian' },
};

export class PyTorchService {
  private checkpoint: ParsedCheckpoint | null = null;
  private root: VNode | null = null;
  private nodeMap = new Map<string, VNode>();
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger || noopLogger;
  }

  async init(filePath: string, onProgress?: (msg: string) => void): Promise<void> {
    const t0 = performance.now();
    const { size } = statSync(filePath);

    onProgress?.(`Extracting PyTorch checkpoint (${(size / 1024 / 1024).toFixed(1)} MB)...`);
    this.checkpoint = parsePyTorchCheckpoint(filePath);

    onProgress?.('Building object tree...');
    this.buildTree();

    this.log.info(`[PyTorch] Parsed in ${(performance.now() - t0).toFixed(0)} ms, prefix="${this.checkpoint.prefix}", storages: ${this.checkpoint.tensorStorages.size}, nodes: ${this.nodeMap.size}`);
    onProgress?.('Ready');
  }

  close(): void {
    this.checkpoint = null;
    this.root = null;
    this.nodeMap.clear();
  }

  getEntity(path: string): unknown {
    const node = this.nodeMap.get(path);
    if (!node) throw new Error(`Entity not found: ${path}`);

    if (node.kind === EntityKind.Group && node.children) {
      return {
        name: node.name, path: node.path, kind: node.kind,
        attributes: node.attributes || [],
        children: node.children.map(c => ({
          name: c.name, path: c.path, kind: c.kind,
          attributes: c.attributes || [],
          ...(c.kind === EntityKind.Dataset ? { shape: c.shape, type: c.type, rawType: {} } : {}),
        })),
      };
    }

    return {
      name: node.name, path: node.path, kind: node.kind,
      shape: node.shape, type: node.type,
      attributes: node.attributes || [],
      rawType: {}, filters: [],
    };
  }

  getValue(path: string, _selection?: string): unknown {
    const node = this.nodeMap.get(path);
    if (!node || node.kind !== EntityKind.Dataset) throw new Error(`Dataset not found: ${path}`);

    // Scalar / simple value
    if (node.value !== undefined && !node._tensorRef) return node.value;

    // Tensor
    if (node._tensorRef && this.checkpoint) {
      return this.readTensor(node._tensorRef);
    }

    return null;
  }

  getAttrValues(path: string): Record<string, unknown> {
    const node = this.nodeMap.get(path);
    if (!node) throw new Error(`Entity not found: ${path}`);
    return (node._attrValues as Record<string, unknown>) || {};
  }

  getSearchablePaths(_rootPath: string): string[] {
    return Array.from(this.nodeMap.keys()).filter(p => p !== '/');
  }

  getAudioHints(): unknown[] { return []; }
  getAudioData(_path: string): unknown { throw new Error('Not supported'); }
  getJsonHints(): unknown[] { return []; }
  getJsonData(_path: string): unknown { throw new Error('Not supported'); }
  async detectDatasetType(_path: string): Promise<unknown> {
    return { category: 'unknown', mime: '', ext: '', label: 'PyTorch Data', detectedBy: 'extension' };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private readTensor(ref: TensorRef): unknown {
    if (!this.checkpoint) throw new Error('Checkpoint not loaded');

    const storageBuf = this.checkpoint.tensorStorages.get(ref.storageKey);
    if (!storageBuf) {
      return `[Tensor storage "${ref.storageKey}" not found]`;
    }

    const dtype = STORAGE_DTYPE[ref.storageType] || 'float32';
    const bytesPerElem = STORAGE_BYTES[ref.storageType] || 4;
    const totalElements = ref.shape.reduce((a, b) => a * b, 1) || 1;
    const byteLen = totalElements * bytesPerElem;

    // Ensure buffer is large enough
    if (storageBuf.length < byteLen) {
      return `[Storage too small: ${storageBuf.length} < ${byteLen}]`;
    }

    const ab = storageBuf.buffer.slice(storageBuf.byteOffset, storageBuf.byteOffset + byteLen);

    let typedArrayName: string;
    let values: number[] | string[];

    switch (dtype) {
      case 'float32':
        typedArrayName = 'Float32Array';
        values = Array.from(new Float32Array(ab));
        break;
      case 'float64':
        typedArrayName = 'Float64Array';
        values = Array.from(new Float64Array(ab));
        break;
      case 'float16': {
        typedArrayName = 'Float32Array';
        const dv = new DataView(ab);
        const f32 = new Float32Array(totalElements);
        for (let i = 0; i < totalElements; i++) {
          const h = dv.getUint16(i * 2, true);
          const sign = (h >> 15) & 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
          if (exp === 0) f32[i] = (sign ? -1 : 1) * (frac / 1024) * Math.pow(2, -14);
          else if (exp === 0x1f) f32[i] = frac ? NaN : (sign ? -Infinity : Infinity);
          else f32[i] = (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
        }
        values = Array.from(f32);
        break;
      }
      case 'bfloat16': {
        typedArrayName = 'Float32Array';
        const dv = new DataView(ab);
        const f32 = new Float32Array(totalElements);
        for (let i = 0; i < totalElements; i++) {
          const bits = dv.getUint16(i * 2, true);
          const tmp = new ArrayBuffer(4);
          new DataView(tmp).setUint32(0, bits << 16, false);
          f32[i] = new DataView(tmp).getFloat32(0, false);
        }
        values = Array.from(f32);
        break;
      }
      case 'int8': typedArrayName = 'Int8Array'; values = Array.from(new Int8Array(ab)); break;
      case 'uint8': typedArrayName = 'Uint8Array'; values = Array.from(new Uint8Array(ab)); break;
      case 'int16': typedArrayName = 'Int16Array'; values = Array.from(new Int16Array(ab)); break;
      case 'int32': typedArrayName = 'Int32Array'; values = Array.from(new Int32Array(ab)); break;
      case 'int64': typedArrayName = 'BigInt64Array'; values = Array.from(new BigInt64Array(ab), v => v.toString()); break;
      case 'bool': typedArrayName = 'Uint8Array'; values = Array.from(new Uint8Array(ab)); break;
      default: typedArrayName = 'Float32Array'; values = Array.from(new Float32Array(ab)); break;
    }

    return { __typedArray: true, type: typedArrayName, data: values };
  }

  private buildTree(): void {
    if (!this.checkpoint) return;

    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };

    this.root = {
      name: '', path: '/', kind: EntityKind.Group, children: [],
      attributes: [{ name: 'format', shape: null, type: strType }],
    };
    this.root._attrValues = { format: `PyTorch checkpoint (${this.checkpoint.prefix})` };

    this.buildNode('/', this.root, this.checkpoint.data);
    this.registerAll(this.root);
  }

  private buildNode(parentPath: string, parentNode: VNode, value: unknown): void {
    if (value === null || value === undefined) return;

    // TensorRef
    if (this.isTensorRef(value)) {
      // Should not happen at group level, but handle gracefully
      return;
    }

    // Dict / Object
    if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set)) {
      const obj = value as Record<string, unknown>;
      for (const [key, val] of Object.entries(obj)) {
        if (key.startsWith('__')) continue; // Skip internal markers
        const childPath = parentPath === '/' ? `/${key}` : `${parentPath}/${key}`;
        const child = this.createNode(key, childPath, val);
        if (!parentNode.children) parentNode.children = [];
        parentNode.children.push(child);
      }
      return;
    }

    // Array — treat as numbered group
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const childPath = parentPath === '/' ? `/${i}` : `${parentPath}/${i}`;
        const child = this.createNode(String(i), childPath, value[i]);
        if (!parentNode.children) parentNode.children = [];
        parentNode.children.push(child);
      }
    }
  }

  private createNode(name: string, path: string, value: unknown): VNode {
    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };

    // TensorRef → Dataset
    if (this.isTensorRef(value)) {
      const ref = value as TensorRef;
      const dtype = STORAGE_DTYPE[ref.storageType] || 'float32';
      const h5type = DTYPE_TO_H5[dtype] || { class: DTypeClass.Unknown };
      const node: VNode = {
        name, path, kind: EntityKind.Dataset,
        shape: ref.shape, type: h5type,
        attributes: [
          { name: 'storage_type', shape: null, type: strType },
          { name: 'device', shape: null, type: strType },
          { name: 'dtype', shape: null, type: strType },
        ],
        _tensorRef: ref,
      };
      node._attrValues = {
        storage_type: ref.storageType,
        device: ref.device,
        dtype,
      };
      return node;
    }

    // Scalar number
    if (typeof value === 'number') {
      const isInt = Number.isInteger(value);
      return {
        name, path, kind: EntityKind.Dataset,
        shape: [],
        type: isInt
          ? { class: DTypeClass.Integer, signed: true, size: 64, endianness: 'little-endian' }
          : { class: DTypeClass.Float, size: 64, endianness: 'little-endian' },
        value, attributes: [],
      };
    }

    // Scalar string
    if (typeof value === 'string') {
      return { name, path, kind: EntityKind.Dataset, shape: [], type: strType, value, attributes: [] };
    }

    // Boolean
    if (typeof value === 'boolean') {
      return { name, path, kind: EntityKind.Dataset, shape: [], type: { class: DTypeClass.Bool, size: 8 }, value: value ? 1 : 0, attributes: [] };
    }

    // Dict / Object / Array → Group
    if (typeof value === 'object' && value !== null) {
      const group: VNode = { name, path, kind: EntityKind.Group, children: [], attributes: [] };
      this.buildNode(path, group, value);
      return group;
    }

    // Fallback
    return { name, path, kind: EntityKind.Dataset, shape: [], type: strType, value: String(value), attributes: [] };
  }

  private isTensorRef(val: unknown): val is TensorRef {
    return typeof val === 'object' && val !== null && (val as TensorRef).__tensorRef === true;
  }

  private registerAll(node: VNode): void {
    this.nodeMap.set(node.path, node);
    if (node.children) {
      for (const child of node.children) this.registerAll(child);
    }
  }
}

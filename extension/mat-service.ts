/**
 * MAT v5/v7 file reading service using mat-for-js.
 *
 * Parses the entire .mat file into memory and exposes its contents
 * through the same RPC interface as H5Service, mapping MATLAB data
 * structures to a virtual HDF5-like tree.
 *
 * Mapping:
 *   MATLAB struct  → Group (each field is a child)
 *   MATLAB cell    → Group (each element is a child: cell_0, cell_1, ...)
 *   MATLAB array   → Dataset
 *   MATLAB string  → Dataset (string type)
 *   MATLAB sparse  → Dataset (attributes: x, y, nz)
 *   MATLAB complex → Dataset (complex type)
 */

import { readFileSync, statSync } from 'node:fs';

import type { Logger } from './h5-service.js';

// DType classes — must match h5-service.ts / @h5web/shared
const DTypeClass = {
  Bool: 'Boolean',
  Integer: 'Integer',
  Float: 'Float',
  Complex: 'Complex',
  String: 'String',
  Compound: 'Compound',
  Array: 'Array',
  VLen: 'Array (variable length)',
  Enum: 'Enumeration',
  Unknown: 'Unknown',
} as const;

const EntityKind = {
  Group: 'group',
  Dataset: 'dataset',
  Unresolved: 'unresolved',
} as const;

// ---------------------------------------------------------------------------
// Virtual tree node types
// ---------------------------------------------------------------------------

interface VNode {
  name: string;
  path: string;
  kind: string;
  // Group
  children?: VNode[];
  // Dataset
  shape?: number[];
  type?: unknown;
  value?: unknown;
  attributes?: Array<{ name: string; shape: number[] | null; type: unknown }>;
  // Extra data stored on nodes (e.g. attribute values)
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MatService
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {},
};

export class MatService {
  private root: VNode | null = null;
  private nodeMap = new Map<string, VNode>();
  private matVersion: string = '';
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger || noopLogger;
  }

  /**
   * Parse the .mat file and build the virtual tree.
   * Returns progress information for the caller to relay to the webview.
   */
  async init(
    filePath: string,
    version: string,
    onProgress?: (message: string) => void,
  ): Promise<void> {
    const t0 = performance.now();
    this.matVersion = version;

    const { size } = statSync(filePath);
    const sizeMB = (size / 1024 / 1024).toFixed(1);

    this.log.info(`[MatService] Initializing for: ${filePath} (${sizeMB} MB, ${version})`);
    onProgress?.(`Reading MAT ${version} file (${sizeMB} MB)...`);

    // Read entire file into memory (MAT v5/v7 has no random access)
    const tRead = performance.now();
    const buf = readFileSync(filePath);
    const arrayBuffer = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    );
    this.log.debug(`[MatService] File read in ${(performance.now() - tRead).toFixed(0)} ms`);

    onProgress?.(`Parsing MAT ${version} data structures...`);

    // Dynamic import to avoid bundling issues
    const tParse = performance.now();
    const { read } = await import('mat-for-js');
    const result = read(arrayBuffer);
    this.log.debug(`[MatService] mat-for-js parsed in ${(performance.now() - tParse).toFixed(0)} ms, variables: ${Object.keys(result.data).length}`);

    onProgress?.('Building virtual tree...');

    // Build virtual tree from parsed data
    this.root = {
      name: '',
      path: '/',
      kind: EntityKind.Group,
      children: [],
      attributes: [
        {
          name: 'mat_version',
          shape: null,
          type: { class: DTypeClass.String, charSet: 'ASCII', strPad: 'null-terminated' },
        },
        {
          name: 'mat_header',
          shape: null,
          type: { class: DTypeClass.String, charSet: 'ASCII', strPad: 'null-terminated' },
        },
      ],
    };
    this.nodeMap.set('/', this.root);

    // Store header info as root-level attribute values
    this.root._attrValues = {
      mat_version: version,
      mat_header: (result.header || '').trim(),
    };

    // Convert each top-level variable
    const data = result.data as Record<string, unknown>;
    for (const [varName, value] of Object.entries(data)) {
      const childPath = `/${varName}`;
      const child = this.buildNode(varName, childPath, value);
      this.root.children!.push(child);
      this.registerNode(child);
    }

    this.log.info(`[MatService] Ready in ${(performance.now() - t0).toFixed(0)} ms, total nodes: ${this.nodeMap.size}`);
    onProgress?.('Ready');
  }

  close(): void {
    this.log.info('[MatService] Closing');
    this.root = null;
    this.nodeMap.clear();
  }

  getEntity(path: string): unknown {
    const node = this.nodeMap.get(path);
    if (!node) {
      throw new Error(`Entity not found: ${path}`);
    }

    if (node.kind === EntityKind.Group && node.children) {
      // Return group with children (one level deep, without their children)
      return {
        name: node.name,
        path: node.path,
        kind: node.kind,
        attributes: node.attributes || [],
        children: node.children.map((c) => ({
          name: c.name,
          path: c.path,
          kind: c.kind,
          attributes: c.attributes || [],
          ...(c.kind === EntityKind.Dataset
            ? { shape: c.shape, type: c.type, rawType: {} }
            : {}),
        })),
      };
    }

    // Dataset
    return {
      name: node.name,
      path: node.path,
      kind: node.kind,
      shape: node.shape,
      type: node.type,
      attributes: node.attributes || [],
      rawType: {},
      filters: [],
    };
  }

  getValue(path: string, selection?: string): unknown {
    const node = this.nodeMap.get(path);
    if (!node || node.kind !== EntityKind.Dataset) {
      throw new Error(`Dataset not found: ${path}`);
    }

    const value = node.value;

    // Apply selection if provided
    if (selection && node.shape && node.shape.length > 0 && Array.isArray(value)) {
      return this.applySelection(value, node.shape, selection);
    }

    return this.serializeValue(value);
  }

  getAttrValues(path: string): Record<string, unknown> {
    const node = this.nodeMap.get(path);
    if (!node) {
      throw new Error(`Entity not found: ${path}`);
    }
    return (node._attrValues as Record<string, unknown>) || {};
  }

  getSearchablePaths(rootPath: string): string[] {
    const paths: string[] = [];
    const collect = (node: VNode) => {
      if (node.path !== rootPath) {
        paths.push(node.path);
      }
      if (node.children) {
        for (const child of node.children) {
          collect(child);
        }
      }
    };
    const startNode = this.nodeMap.get(rootPath);
    if (startNode) {
      collect(startNode);
    }
    return paths;
  }

  // ---------------------------------------------------------------------------
  // Private: Tree building
  // ---------------------------------------------------------------------------

  private registerNode(node: VNode): void {
    this.nodeMap.set(node.path, node);
    if (node.children) {
      for (const child of node.children) {
        this.registerNode(child);
      }
    }
  }

  private buildNode(name: string, path: string, value: unknown): VNode {
    // null / undefined
    if (value === null || value === undefined) {
      return this.makeDataset(name, path, [], this.inferDType(value), value);
    }

    // String
    if (typeof value === 'string') {
      return this.makeDataset(name, path, [], { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' }, value);
    }

    // BigInt scalar
    if (typeof value === 'bigint') {
      return this.makeDataset(name, path, [], { class: DTypeClass.Integer, signed: true, size: 64, endianness: 'little-endian' }, { __bigint: true, value: value.toString() });
    }

    // Number scalar
    if (typeof value === 'number') {
      return this.makeDataset(name, path, [], { class: DTypeClass.Float, size: 64, endianness: 'little-endian' }, value);
    }

    // Boolean scalar
    if (typeof value === 'boolean') {
      return this.makeDataset(name, path, [], { class: DTypeClass.Integer, signed: false, size: 8, endianness: 'little-endian' }, value ? 1 : 0);
    }

    // Complex number { r, i }
    if (this.isComplex(value)) {
      const c = value as { r: number; i: number };
      return this.makeDataset(name, path, [], {
        class: DTypeClass.Complex,
        realType: { class: DTypeClass.Float, size: 64, endianness: 'little-endian' },
        imagType: { class: DTypeClass.Float, size: 64, endianness: 'little-endian' },
      }, [c.r, c.i]);
    }

    // Sparse { x, y, nz }
    if (this.isSparse(value)) {
      return this.buildSparseNode(name, path, value as { x: number; y: number; nz: Array<{ x: number; y: number; v: number }> });
    }

    // TypedArray
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const ta = value as Float64Array;
      return this.makeDataset(name, path, [ta.length], this.inferTypedArrayDType(ta), this.serializeValue(ta));
    }

    // Plain object (struct) — but not an array
    if (typeof value === 'object' && !Array.isArray(value)) {
      return this.buildStructNode(name, path, value as Record<string, unknown>);
    }

    // Array
    if (Array.isArray(value)) {
      return this.buildArrayNode(name, path, value);
    }

    // Fallback
    return this.makeDataset(name, path, [], { class: DTypeClass.Unknown }, String(value));
  }

  private buildStructNode(name: string, path: string, obj: Record<string, unknown>): VNode {
    const children: VNode[] = [];
    for (const [fieldName, fieldValue] of Object.entries(obj)) {
      const childPath = `${path}/${fieldName}`;
      children.push(this.buildNode(fieldName, childPath, fieldValue));
    }
    return {
      name,
      path,
      kind: EntityKind.Group,
      children,
      attributes: [],
    };
  }

  private buildSparseNode(name: string, path: string, sparse: { x: number; y: number; nz: Array<{ x: number; y: number; v: number }> }): VNode {
    // Convert sparse to dense 2D array for visualization
    const rows = sparse.y;
    const cols = sparse.x;

    // For small sparse matrices, convert to dense
    if (rows * cols <= 1_000_000) {
      const dense = new Float64Array(rows * cols);
      for (const entry of sparse.nz) {
        dense[entry.y * cols + entry.x] = entry.v;
      }
      return this.makeDataset(name, path, [rows, cols], {
        class: DTypeClass.Float, size: 64, endianness: 'little-endian',
      }, {
        __typedArray: true,
        type: 'Float64Array',
        data: Array.from(dense),
      });
    }

    // For large sparse matrices, store as group with indices and values
    const group: VNode = {
      name, path, kind: EntityKind.Group, children: [], attributes: [
        { name: 'sparse', shape: null, type: { class: DTypeClass.String, charSet: 'ASCII', strPad: 'null-terminated' } },
      ],
    };
    group._attrValues = {
      sparse: 'true',
      rows: rows,
      cols: cols,
    };

    const rowIndices = new Int32Array(sparse.nz.map((e) => e.y));
    const colIndices = new Int32Array(sparse.nz.map((e) => e.x));
    const values = new Float64Array(sparse.nz.map((e) => e.v));

    group.children!.push(
      this.makeDataset('row', `${path}/row`, [rowIndices.length],
        { class: DTypeClass.Integer, signed: true, size: 32, endianness: 'little-endian' },
        { __typedArray: true, type: 'Int32Array', data: Array.from(rowIndices) }),
      this.makeDataset('col', `${path}/col`, [colIndices.length],
        { class: DTypeClass.Integer, signed: true, size: 32, endianness: 'little-endian' },
        { __typedArray: true, type: 'Int32Array', data: Array.from(colIndices) }),
      this.makeDataset('value', `${path}/value`, [values.length],
        { class: DTypeClass.Float, size: 64, endianness: 'little-endian' },
        { __typedArray: true, type: 'Float64Array', data: Array.from(values) }),
    );

    return group;
  }

  private buildArrayNode(name: string, path: string, arr: unknown[]): VNode {
    if (arr.length === 0) {
      return this.makeDataset(name, path, [0], { class: DTypeClass.Float, size: 64, endianness: 'little-endian' }, []);
    }

    // Check if it's an array of complex numbers
    if (arr.every((el) => this.isComplex(el))) {
      const complexArr = arr as Array<{ r: number; i: number }>;
      const flat = complexArr.flatMap((c) => [c.r, c.i]);
      return this.makeDataset(name, path, [complexArr.length], {
        class: DTypeClass.Complex,
        realType: { class: DTypeClass.Float, size: 64, endianness: 'little-endian' },
        imagType: { class: DTypeClass.Float, size: 64, endianness: 'little-endian' },
      }, flat);
    }

    // Check if it's a flat numeric array
    if (arr.every((el) => typeof el === 'number')) {
      const typed = new Float64Array(arr as number[]);
      return this.makeDataset(name, path, [arr.length], {
        class: DTypeClass.Float, size: 64, endianness: 'little-endian',
      }, { __typedArray: true, type: 'Float64Array', data: arr });
    }

    // Check if it's a flat BigInt array
    if (arr.every((el) => typeof el === 'bigint')) {
      return this.makeDataset(name, path, [arr.length], {
        class: DTypeClass.Integer, signed: true, size: 64, endianness: 'little-endian',
      }, { __typedArray: true, type: 'BigInt64Array', data: (arr as bigint[]).map((v) => v.toString()) });
    }

    // Check if it's a flat string array
    if (arr.every((el) => typeof el === 'string')) {
      return this.makeDataset(name, path, [arr.length], {
        class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated',
      }, arr);
    }

    // Check if it's a 2D numeric array (matrix)
    if (arr.every((el) => Array.isArray(el) && (el as unknown[]).every((v) => typeof v === 'number'))) {
      const matrix = arr as number[][];
      const rows = matrix.length;
      const cols = matrix[0].length;
      if (matrix.every((row) => row.length === cols)) {
        const flat = new Float64Array(rows * cols);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            flat[r * cols + c] = matrix[r][c];
          }
        }
        return this.makeDataset(name, path, [rows, cols], {
          class: DTypeClass.Float, size: 64, endianness: 'little-endian',
        }, { __typedArray: true, type: 'Float64Array', data: Array.from(flat) });
      }
    }

    // Check if it's a 3D+ numeric array
    const shape = this.inferNDShape(arr);
    if (shape && shape.length >= 3) {
      const flat = this.flattenND(arr, shape);
      if (flat) {
        return this.makeDataset(name, path, shape, {
          class: DTypeClass.Float, size: 64, endianness: 'little-endian',
        }, { __typedArray: true, type: 'Float64Array', data: flat });
      }
    }

    // Mixed array or struct array → treat as cell (group)
    const group: VNode = {
      name, path, kind: EntityKind.Group, children: [], attributes: [],
    };
    for (let i = 0; i < arr.length; i++) {
      const childName = `${i}`;
      const childPath = `${path}/${childName}`;
      group.children!.push(this.buildNode(childName, childPath, arr[i]));
    }
    return group;
  }

  // ---------------------------------------------------------------------------
  // Private: Helpers
  // ---------------------------------------------------------------------------

  private makeDataset(
    name: string,
    path: string,
    shape: number[],
    type: unknown,
    value: unknown,
  ): VNode {
    return {
      name,
      path,
      kind: EntityKind.Dataset,
      shape,
      type,
      value,
      attributes: [],
    };
  }

  private isComplex(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      'r' in value &&
      'i' in value &&
      typeof (value as Record<string, unknown>).r === 'number' &&
      typeof (value as Record<string, unknown>).i === 'number'
    );
  }

  private isSparse(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      'x' in value &&
      'y' in value &&
      'nz' in value &&
      Array.isArray((value as Record<string, unknown>).nz)
    );
  }

  private inferDType(value: unknown): unknown {
    if (value === null || value === undefined) {
      return { class: DTypeClass.Unknown };
    }
    if (typeof value === 'number') {
      return { class: DTypeClass.Float, size: 64, endianness: 'little-endian' };
    }
    if (typeof value === 'string') {
      return { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };
    }
    return { class: DTypeClass.Unknown };
  }

  private inferTypedArrayDType(ta: ArrayBufferView): unknown {
    const name = ta.constructor.name;
    switch (name) {
      case 'Int8Array': return { class: DTypeClass.Integer, signed: true, size: 8, endianness: 'little-endian' };
      case 'Uint8Array': return { class: DTypeClass.Integer, signed: false, size: 8, endianness: 'little-endian' };
      case 'Int16Array': return { class: DTypeClass.Integer, signed: true, size: 16, endianness: 'little-endian' };
      case 'Uint16Array': return { class: DTypeClass.Integer, signed: false, size: 16, endianness: 'little-endian' };
      case 'Int32Array': return { class: DTypeClass.Integer, signed: true, size: 32, endianness: 'little-endian' };
      case 'Uint32Array': return { class: DTypeClass.Integer, signed: false, size: 32, endianness: 'little-endian' };
      case 'Float32Array': return { class: DTypeClass.Float, size: 32, endianness: 'little-endian' };
      case 'Float64Array': return { class: DTypeClass.Float, size: 64, endianness: 'little-endian' };
      case 'BigInt64Array': return { class: DTypeClass.Integer, signed: true, size: 64, endianness: 'little-endian' };
      case 'BigUint64Array': return { class: DTypeClass.Integer, signed: false, size: 64, endianness: 'little-endian' };
      default: return { class: DTypeClass.Unknown };
    }
  }

  private inferNDShape(arr: unknown[]): number[] | null {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    if (typeof arr[0] === 'number') return [arr.length];
    if (!Array.isArray(arr[0])) return null;

    const innerShape = this.inferNDShape(arr[0] as unknown[]);
    if (!innerShape) return null;

    // Verify all sub-arrays have same shape
    for (const sub of arr) {
      if (!Array.isArray(sub)) return null;
      const subShape = this.inferNDShape(sub as unknown[]);
      if (!subShape || subShape.length !== innerShape.length) return null;
      for (let i = 0; i < innerShape.length; i++) {
        if (subShape[i] !== innerShape[i]) return null;
      }
    }

    return [arr.length, ...innerShape];
  }

  private flattenND(arr: unknown[], shape: number[]): number[] | null {
    const result: number[] = [];
    const flatten = (val: unknown): boolean => {
      if (typeof val === 'number') {
        result.push(val);
        return true;
      }
      if (Array.isArray(val)) {
        for (const item of val) {
          if (!flatten(item)) return false;
        }
        return true;
      }
      return false;
    };
    return flatten(arr) ? result : null;
  }

  private applySelection(value: unknown, shape: number[], selection: string): unknown {
    // For now, return the full value — @h5web/app handles selection
    // for 3D+ datasets by passing "0,:,:" style selections.
    // Since MAT data is already in memory, we can slice it.
    return this.serializeValue(value);
  }

  private serializeValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') {
      return { __bigint: true, value: value.toString() };
    }
    if (typeof value === 'object' && '__typedArray' in (value as Record<string, unknown>)) {
      return value; // Already serialized
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
        return {
          __typedArray: true,
          type: value.constructor.name,
          data: Array.from(value, (v: bigint) => v.toString()),
        };
      }
      const ta = value as Float64Array;
      return {
        __typedArray: true,
        type: ta.constructor.name,
        data: Array.from(ta),
      };
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.serializeValue(v));
    }
    return value;
  }
}

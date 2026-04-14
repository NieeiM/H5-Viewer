/**
 * GGUF file reading service.
 *
 * Maps GGUF structure into a virtual HDF5-like tree:
 *   /metadata/    → Group with all key-value metadata as scalar datasets
 *   /tensors/     → Group with hierarchical tensor tree (dot-separated names)
 */

import type { Logger } from './h5-service.js';
import {
  parseGGUFHeader, readGGUFTensor, GGML_TYPE_NAME,
  type GGUFHeader, type GGUFTensorInfo,
} from './gguf-parser.js';
import { statSync } from 'node:fs';

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
  _tensorIdx?: number;
  [key: string]: unknown;
}

const noopLogger: Logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

export class GGUFService {
  private header: GGUFHeader | null = null;
  private filePath: string = '';
  private root: VNode | null = null;
  private nodeMap = new Map<string, VNode>();
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger || noopLogger;
  }

  async init(filePath: string, onProgress?: (msg: string) => void): Promise<void> {
    const t0 = performance.now();
    this.filePath = filePath;
    const { size } = statSync(filePath);

    onProgress?.(`Parsing GGUF header (${(size / 1024 / 1024).toFixed(1)} MB)...`);
    this.header = parseGGUFHeader(filePath);

    this.log.info(`[GGUF] v${this.header.version}, ${this.header.tensorCount} tensors, ${Object.keys(this.header.metadata).length} metadata keys`);
    onProgress?.('Building tensor tree...');

    this.buildTree();

    this.log.info(`[GGUF] Ready in ${(performance.now() - t0).toFixed(0)} ms, nodes: ${this.nodeMap.size}`);
    onProgress?.('Ready');
  }

  close(): void {
    this.root = null;
    this.nodeMap.clear();
    this.header = null;
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

    // Metadata scalar values
    if (node.value !== undefined) return node.value;

    // Tensor data
    if (node._tensorIdx !== undefined && this.header) {
      const tensorInfo = this.header.tensors[node._tensorIdx];
      const t0 = performance.now();
      const result = readGGUFTensor(this.filePath, this.header, tensorInfo);

      if (result) {
        this.log.debug(`[GGUF] Read tensor "${tensorInfo.name}" [${tensorInfo.shape}] ${tensorInfo.typeName} in ${(performance.now() - t0).toFixed(0)} ms`);
        return result.data;
      }

      // Quantized tensor — return info string
      return `[Quantized tensor: ${tensorInfo.typeName}, ${tensorInfo.numElements.toLocaleString()} elements, ${(tensorInfo.sizeBytes / 1024 / 1024).toFixed(1)} MB. Dequantization not yet supported.]`;
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
    return { category: 'unknown', mime: '', ext: '', label: 'Tensor', detectedBy: 'extension' };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private buildTree(): void {
    if (!this.header) return;

    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };
    const floatType = { class: DTypeClass.Float, size: 64, endianness: 'little-endian' };
    const intType = { class: DTypeClass.Integer, signed: true, size: 64, endianness: 'little-endian' };

    this.root = {
      name: '', path: '/', kind: EntityKind.Group, children: [], attributes: [
        { name: 'format', shape: null, type: strType },
        { name: 'version', shape: null, type: strType },
      ],
    };
    this.root._attrValues = {
      format: 'GGUF',
      version: String(this.header.version),
    };

    // /metadata group
    const metaGroup: VNode = {
      name: 'metadata', path: '/metadata', kind: EntityKind.Group, children: [], attributes: [],
    };

    for (const [key, value] of Object.entries(this.header.metadata)) {
      const safeName = key.replace(/\./g, '/');
      const dsPath = `/metadata/${safeName}`;

      let dtype: unknown = strType;
      let dsValue: unknown = value;
      let shape: number[] = [];

      if (typeof value === 'number') {
        dtype = Number.isInteger(value) ? intType : floatType;
      } else if (typeof value === 'boolean') {
        dtype = { class: DTypeClass.Bool, size: 8 } as unknown as typeof strType;
        dsValue = value ? 1 : 0;
      } else if (Array.isArray(value)) {
        shape = [value.length];
        if (value.length > 0 && typeof value[0] === 'number') {
          dtype = floatType;
          dsValue = { __typedArray: true, type: 'Float64Array', data: value };
        } else {
          dsValue = value.map(String);
        }
      } else {
        dsValue = String(value);
      }

      // Handle nested keys by creating intermediate groups
      const parts = safeName.split('/');
      let parentGroup = metaGroup;
      for (let i = 0; i < parts.length - 1; i++) {
        const partPath = '/metadata/' + parts.slice(0, i + 1).join('/');
        let child = parentGroup.children?.find(c => c.path === partPath && c.kind === EntityKind.Group);
        if (!child) {
          child = { name: parts[i], path: partPath, kind: EntityKind.Group, children: [], attributes: [] };
          if (!parentGroup.children) parentGroup.children = [];
          parentGroup.children.push(child);
        }
        parentGroup = child;
      }

      const dsNode: VNode = {
        name: parts[parts.length - 1],
        path: '/metadata/' + safeName,
        kind: EntityKind.Dataset,
        shape, type: dtype, value: dsValue, attributes: [],
      };
      if (!parentGroup.children) parentGroup.children = [];
      parentGroup.children.push(dsNode);
    }

    // /tensors group — hierarchical tree from dot-separated names
    const tensorsGroup: VNode = {
      name: 'tensors', path: '/tensors', kind: EntityKind.Group, children: [], attributes: [],
    };

    for (let idx = 0; idx < this.header.tensors.length; idx++) {
      const t = this.header.tensors[idx];
      const parts = t.name.split('.');
      let currentNode = tensorsGroup;
      let currentPath = '/tensors';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath += '/' + part;
        const isLast = i === parts.length - 1;

        if (isLast) {
          const isQuantized = ![0, 1, 24, 25, 26, 27, 28, 30].includes(t.type);
          // Map GGML type to h5web dtype
          let dtype: unknown;
          if (t.type === 0) dtype = { class: DTypeClass.Float, size: 32, endianness: 'little-endian' };
          else if (t.type === 1 || t.type === 30) dtype = { class: DTypeClass.Float, size: 16, endianness: 'little-endian' };
          else if (t.type === 24) dtype = { class: DTypeClass.Integer, signed: true, size: 8, endianness: 'little-endian' };
          else if (t.type === 28) dtype = { class: DTypeClass.Float, size: 64, endianness: 'little-endian' };
          else dtype = { class: DTypeClass.Unknown };

          const dsNode: VNode = {
            name: part, path: currentPath, kind: EntityKind.Dataset,
            shape: t.shape, type: dtype,
            attributes: [
              { name: 'ggml_type', shape: null, type: strType },
              { name: 'size_bytes', shape: null, type: strType },
              { name: 'quantized', shape: null, type: strType },
            ],
            _tensorIdx: idx,
          };
          dsNode._attrValues = {
            ggml_type: t.typeName,
            size_bytes: t.sizeBytes.toLocaleString(),
            quantized: isQuantized ? 'yes' : 'no',
          };

          if (!currentNode.children) currentNode.children = [];
          currentNode.children.push(dsNode);
        } else {
          if (!currentNode.children) currentNode.children = [];
          let child = currentNode.children.find(c => c.name === part && c.kind === EntityKind.Group);
          if (!child) {
            child = { name: part, path: currentPath, kind: EntityKind.Group, children: [], attributes: [] };
            currentNode.children.push(child);
          }
          currentNode = child;
        }
      }
    }

    this.root.children = [metaGroup, tensorsGroup];
    this.registerAll(this.root);
  }

  private registerAll(node: VNode): void {
    this.nodeMap.set(node.path, node);
    if (node.children) {
      for (const child of node.children) this.registerAll(child);
    }
  }
}

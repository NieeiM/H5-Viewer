/**
 * SafeTensors file reading service.
 *
 * Maps the flat tensor list into a hierarchical tree matching the
 * dot-separated naming convention (e.g. "model.layers.0.weight" →
 * /model/layers/0/weight), then exposes via the standard DataService
 * interface for on-demand tensor loading.
 */

import { statSync } from 'node:fs';
import type { Logger } from './h5-service.js';
import {
  parseSafeTensorsHeader, readSafeTensor, SAFETENSOR_DTYPE_MAP,
  type SafeTensorsHeader,
} from './safetensors-parser.js';

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
  attributes?: Array<{ name: string; shape: number[] | null; type: unknown }>;
  _tensorName?: string; // Original safetensors tensor name
  [key: string]: unknown;
}

const noopLogger: Logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

export class SafeTensorsService {
  private header: SafeTensorsHeader | null = null;
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
    const sizeMB = (size / 1024 / 1024).toFixed(1);

    onProgress?.(`Parsing SafeTensors header (${sizeMB} MB)...`);
    this.header = parseSafeTensorsHeader(filePath);

    this.log.info(`[SafeTensors] ${this.header.tensors.size} tensors, header ${this.header.headerSize} bytes`);
    onProgress?.('Building tensor tree...');

    this.buildTree();

    this.log.info(`[SafeTensors] Ready in ${(performance.now() - t0).toFixed(0)} ms, nodes: ${this.nodeMap.size}`);
    onProgress?.('Ready');
  }

  close(): void {
    this.root = null;
    this.nodeMap.clear();
    this.header = null;
    this.log.info('[SafeTensors] Closed');
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
    if (!node || node.kind !== EntityKind.Dataset || !node._tensorName) {
      throw new Error(`Dataset not found: ${path}`);
    }
    if (!this.header) throw new Error('File not loaded');

    const t0 = performance.now();
    const result = readSafeTensor(this.filePath, this.header, node._tensorName);
    this.log.debug(`[SafeTensors] Read tensor "${node._tensorName}" [${result.shape}] in ${(performance.now() - t0).toFixed(0)} ms`);
    return result.data;
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
  // Private: tree building
  // ---------------------------------------------------------------------------

  private buildTree(): void {
    if (!this.header) return;

    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };

    this.root = {
      name: '', path: '/', kind: EntityKind.Group, children: [], attributes: [
        { name: 'format', shape: null, type: strType },
        { name: 'num_tensors', shape: null, type: strType },
      ],
    };
    this.root._attrValues = {
      format: 'SafeTensors',
      num_tensors: String(this.header.tensors.size),
      ...this.header.metadata,
    };
    // Add metadata keys as attributes
    for (const key of Object.keys(this.header.metadata)) {
      this.root.attributes!.push({ name: key, shape: null, type: strType });
    }

    // Build hierarchical tree from dot-separated tensor names
    // e.g. "model.layers.0.self_attn.q_proj.weight" → /model/layers/0/self_attn/q_proj/weight
    for (const [tensorName, info] of this.header.tensors) {
      const parts = tensorName.split('.');
      let currentNode = this.root;
      let currentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath += '/' + part;
        const isLast = i === parts.length - 1;

        if (isLast) {
          // Create dataset node
          const dtypeInfo = SAFETENSOR_DTYPE_MAP[info.dtype];
          const dtype = dtypeInfo ? {
            class: dtypeInfo.class,
            size: dtypeInfo.size,
            endianness: 'little-endian',
            ...(dtypeInfo.signed !== undefined ? { signed: dtypeInfo.signed } : {}),
          } : { class: DTypeClass.Unknown };

          const totalElements = info.shape.reduce((a, b) => a * b, 1) || 1;
          const totalBytes = totalElements * (dtypeInfo?.bytesPerElement || 4);

          const dsNode: VNode = {
            name: part, path: currentPath, kind: EntityKind.Dataset,
            shape: info.shape, type: dtype,
            attributes: [
              { name: 'dtype', shape: null, type: strType },
              { name: 'size_bytes', shape: null, type: strType },
            ],
            _tensorName: tensorName,
          };
          dsNode._attrValues = {
            dtype: info.dtype,
            size_bytes: totalBytes.toLocaleString(),
          };

          if (!currentNode.children) currentNode.children = [];
          currentNode.children.push(dsNode);
        } else {
          // Find or create group node
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

    // Register all nodes
    this.registerAll(this.root);
  }

  private registerAll(node: VNode): void {
    this.nodeMap.set(node.path, node);
    if (node.children) {
      for (const child of node.children) this.registerAll(child);
    }
  }
}

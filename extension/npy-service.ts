/**
 * Standalone .npy file reading service.
 *
 * Reads a .npy file as a single dataset, exposed via the standard
 * DataService interface so @h5web/app can visualize it.
 */

import { readFileSync, statSync } from 'node:fs';
import type { Logger } from './h5-service.js';
import { parseNpy, type NpyResult } from './npy-parser.js';

const DTypeClass = {
  Float: 'Float', Integer: 'Integer', String: 'String', Bool: 'Boolean', Unknown: 'Unknown',
} as const;

const EntityKind = { Group: 'group', Dataset: 'dataset' } as const;

const noopLogger: Logger = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

export class NpyService {
  private npyResult: NpyResult | null = null;
  private fileName: string = '';
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger || noopLogger;
  }

  async init(filePath: string, onProgress?: (msg: string) => void): Promise<void> {
    const t0 = performance.now();
    const { size } = statSync(filePath);
    this.fileName = filePath.split('/').pop() || 'data.npy';

    onProgress?.(`Reading NPY file (${(size / 1024).toFixed(1)} KB)...`);

    const buf = readFileSync(filePath);
    this.npyResult = parseNpy(buf);

    this.log.info(`[NpyService] Parsed ${this.fileName}: shape=[${this.npyResult.shape}] dtype=${this.npyResult.npyDtype} in ${(performance.now() - t0).toFixed(0)} ms`);
    onProgress?.('Ready');
  }

  close(): void {
    this.npyResult = null;
  }

  getEntity(path: string): unknown {
    if (!this.npyResult) throw new Error('File not loaded');
    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };

    if (path === '/') {
      return {
        name: '', path: '/', kind: EntityKind.Group,
        attributes: [
          { name: 'format', shape: null, type: strType },
          { name: 'numpy_dtype', shape: null, type: strType },
        ],
        children: [{
          name: 'data', path: '/data', kind: EntityKind.Dataset,
          shape: this.npyResult.shape, type: this.npyResult.dtype,
          attributes: [{ name: 'numpy_dtype', shape: null, type: strType }],
          rawType: {},
        }],
      };
    }

    if (path === '/data') {
      return {
        name: 'data', path: '/data', kind: EntityKind.Dataset,
        shape: this.npyResult.shape, type: this.npyResult.dtype,
        attributes: [{ name: 'numpy_dtype', shape: null, type: strType }],
        rawType: {}, filters: [],
      };
    }

    throw new Error(`Entity not found: ${path}`);
  }

  getValue(path: string, _selection?: string): unknown {
    if (!this.npyResult || path !== '/data') throw new Error(`Dataset not found: ${path}`);
    return this.npyResult.value;
  }

  getAttrValues(path: string): Record<string, unknown> {
    if (!this.npyResult) return {};
    if (path === '/') return { format: 'NumPy .npy', numpy_dtype: this.npyResult.npyDtype };
    if (path === '/data') return { numpy_dtype: this.npyResult.npyDtype };
    return {};
  }

  getSearchablePaths(_rootPath: string): string[] {
    return ['/data'];
  }

  getAudioHints(): unknown[] { return []; }
  getAudioData(_path: string): unknown { throw new Error('Not supported'); }
  getJsonHints(): unknown[] { return []; }
  getJsonData(_path: string): unknown { throw new Error('Not supported'); }
  async detectDatasetType(_path: string): Promise<unknown> {
    return { category: 'npy', mime: 'application/x-numpy', ext: 'npy', label: 'NumPy Array', detectedBy: 'extension' };
  }
}

/**
 * HDF5 file reading service using h5wasm/node.
 *
 * Runs in the Extension Host (Node.js process on the remote server).
 * Uses NODERAWFS to read files directly from the filesystem — no
 * buffer copying, no file-size limitation.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isAudioByName, isAudioByShape,
  makeEncodedBlobHint, makePcmArrayHint,
  extractSampleRate, inferAudioLayout,
} from './audio-detect.js';
import { detectContentType, DETECTION_SAMPLE_SIZE, type ContentCategory } from './magic-detect.js';
import type { AudioHint } from './models.js';
import { parseNpy } from './npy-parser.js';
import { PLUGINS } from './plugins.js';
import {
  parseSafeTensorsHeader, readSafeTensor, SAFETENSOR_DTYPE_MAP,
  isSafeTensorsFile as isSafeTensorsBuffer,
} from './safetensors-parser.js';

// Patterns for special dataset names
const NPY_EXT = /\.npy$/i;
const SAFETENSORS_EXT = /\.safetensors$/i;
const JSON_EXT = /\.json$/i;

// We use `any` for h5wasm types since the module is loaded dynamically
// and esbuild marks it as external.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Metadata = any;

// ---------------------------------------------------------------------------
// H5T constants (mirrors @h5web/shared/h5t — not exported by @h5web/app)
// ---------------------------------------------------------------------------

const H5T_CLASS = {
  INTEGER: 0,
  FLOAT: 1,
  TIME: 2,
  STRING: 3,
  BITFIELD: 4,
  OPAQUE: 5,
  COMPOUND: 6,
  REFERENCE: 7,
  ENUM: 8,
  VLEN: 9,
  ARRAY: 10,
} as const;

const H5T_TO_ENDIANNESS: Record<number, string | undefined> = {
  0: 'little-endian',
  1: 'big-endian',
  2: 'VAX',
  3: 'mixed',
  4: 'none',
};

const H5T_TO_CHAR_SET: Record<number, string | undefined> = {
  0: 'ASCII',
  1: 'UTF-8',
};

const H5T_TO_STR_PAD: Record<number, string | undefined> = {
  0: 'null-terminated',
  1: 'null-padded',
  2: 'space-padded',
};

// ---------------------------------------------------------------------------
// DType classes (mirrors @h5web/shared/hdf5-models)
// ---------------------------------------------------------------------------

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
  Time: 'Time',
  Bitfield: 'Bitfield',
  Opaque: 'Opaque',
  Reference: 'Reference',
  Unknown: 'Unknown',
} as const;

const EntityKind = {
  Group: 'group',
  Dataset: 'dataset',
  Datatype: 'datatype',
  Unresolved: 'unresolved',
} as const;

// ---------------------------------------------------------------------------
// Plugin filter ID mapping (mirrors @h5web/h5wasm utils)
// ---------------------------------------------------------------------------

const PLUGINS_BY_FILTER_ID: Record<number, string | undefined> = {
  307: 'bz2',
  32_000: 'lzf',
  32_001: 'blosc',
  32_004: 'lz4',
  32_008: 'bshuf',
  32_013: 'zfp',
  32_015: 'zstd',
  32_019: 'jpeg',
  32_026: 'blosc2',
};

// ---------------------------------------------------------------------------
// Type builder helpers (mirrors @h5web/shared/hdf5-utils)
// ---------------------------------------------------------------------------

function intType(signed = true, size = 32, littleEndian = true) {
  return {
    class: DTypeClass.Integer,
    signed,
    endianness: H5T_TO_ENDIANNESS[littleEndian ? 0 : 1],
    size,
  };
}

function floatType(size = 32, littleEndian = true) {
  return {
    class: DTypeClass.Float,
    endianness: H5T_TO_ENDIANNESS[littleEndian ? 0 : 1],
    size,
  };
}

function strType(cset?: number, strpad?: number, length?: number) {
  return {
    class: DTypeClass.String,
    charSet: cset !== undefined ? H5T_TO_CHAR_SET[cset] : 'ASCII',
    strPad: strpad !== undefined ? H5T_TO_STR_PAD[strpad] : 'null-terminated',
    ...(length !== undefined && { length }),
  };
}

function compoundOrCplxType(fields: Record<string, unknown>) {
  const r = fields.r as Record<string, unknown> | undefined;
  const i = fields.i as Record<string, unknown> | undefined;
  if (
    r &&
    i &&
    Object.keys(fields).length === 2 &&
    isNumericType(r) &&
    isNumericType(i)
  ) {
    return { class: DTypeClass.Complex, realType: r, imagType: i };
  }
  return { class: DTypeClass.Compound, fields };
}

function isNumericType(t: Record<string, unknown>): boolean {
  return t.class === DTypeClass.Integer || t.class === DTypeClass.Float;
}

function enumOrBoolType(
  baseType: Record<string, unknown>,
  hdf5Mapping: Record<string, number>,
) {
  if (
    Object.keys(hdf5Mapping).length === 2 &&
    hdf5Mapping.FALSE === 0 &&
    hdf5Mapping.TRUE === 1
  ) {
    return { class: DTypeClass.Bool, base: baseType };
  }
  return {
    class: DTypeClass.Enum,
    base: baseType,
    mapping: Object.fromEntries(
      Object.entries(hdf5Mapping).map(([k, v]) => [v, k]),
    ),
  };
}

// ---------------------------------------------------------------------------
// parseDType — converts h5wasm Metadata to h5web DType
// ---------------------------------------------------------------------------

function parseDType(metadata: Metadata): unknown {
  const { type: h5tClass, size } = metadata;

  if (h5tClass === H5T_CLASS.INTEGER) {
    return intType(metadata.signed, size * 8, metadata.littleEndian);
  }
  if (h5tClass === H5T_CLASS.FLOAT) {
    return floatType(size * 8, metadata.littleEndian);
  }
  if (h5tClass === H5T_CLASS.TIME) {
    return { class: DTypeClass.Time };
  }
  if (h5tClass === H5T_CLASS.STRING) {
    return strType(
      metadata.cset,
      metadata.strpad,
      metadata.vlen ? undefined : size,
    );
  }
  if (h5tClass === H5T_CLASS.BITFIELD) {
    return {
      class: DTypeClass.Bitfield,
      endianness: H5T_TO_ENDIANNESS[metadata.littleEndian ? 0 : 1],
    };
  }
  if (h5tClass === H5T_CLASS.OPAQUE) {
    return { class: DTypeClass.Opaque, tag: '' };
  }
  if (h5tClass === H5T_CLASS.COMPOUND) {
    const ct = metadata.compound_type;
    if (!ct) return { class: DTypeClass.Unknown };
    const fields: Record<string, unknown> = {};
    for (const member of ct.members) {
      fields[member.name] = parseDType(member);
    }
    return compoundOrCplxType(fields);
  }
  if (h5tClass === H5T_CLASS.REFERENCE) {
    return { class: DTypeClass.Reference };
  }
  if (h5tClass === H5T_CLASS.ENUM) {
    const et = metadata.enum_type;
    if (!et) return { class: DTypeClass.Unknown };
    const baseType = parseDType({ ...metadata, type: et.type });
    if (!isNumericType(baseType as Record<string, unknown>)) {
      return { class: DTypeClass.Unknown };
    }
    return enumOrBoolType(
      baseType as Record<string, unknown>,
      et.members,
    );
  }
  if (h5tClass === H5T_CLASS.VLEN) {
    const vt = metadata.vlen_type;
    if (!vt) return { class: DTypeClass.Unknown };
    return { class: DTypeClass.VLen, base: parseDType(vt) };
  }
  if (h5tClass === H5T_CLASS.ARRAY) {
    const at = metadata.array_type;
    if (!at || !at.shape) return { class: DTypeClass.Unknown };
    return { class: DTypeClass.Array, base: parseDType(at), dims: at.shape };
  }

  return { class: DTypeClass.Unknown };
}

// ---------------------------------------------------------------------------
// parseVirtualSources
// ---------------------------------------------------------------------------

function parseVirtualSources(
  metadata: Metadata,
): Array<{ file: string; path: string }> | undefined {
  return metadata.virtual_sources?.map(
    (vs: { file_name: string; dset_name: string }) => ({
      file: vs.file_name,
      path: vs.dset_name,
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers for entity path building
// ---------------------------------------------------------------------------

function buildEntityPath(parentPath: string, childName: string): string {
  return parentPath === '/' ? `/${childName}` : `${parentPath}/${childName}`;
}

function getNameFromPath(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1];
}

// ---------------------------------------------------------------------------
// Value serialization — convert TypedArrays to plain arrays for postMessage
// ---------------------------------------------------------------------------

function isTypedArray(
  value: unknown,
): value is
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/**
 * Serialize a value for postMessage transport.
 * TypedArrays → { __typedArray: true, type: 'Float32Array', data: [...] }
 * BigInt arrays → { __typedArray: true, type: 'BigInt64Array', data: [...string] }
 * Nested arrays are handled recursively.
 */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return { __bigint: true, value: value.toString() };
  }

  if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
    return {
      __typedArray: true,
      type: value instanceof BigInt64Array ? 'BigInt64Array' : 'BigUint64Array',
      data: Array.from(value, (v) => v.toString()),
    };
  }

  if (isTypedArray(value)) {
    const type = value.constructor.name;
    return {
      __typedArray: true,
      type,
      data: Array.from(value as Float64Array),
    };
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  return value;
}

// ---------------------------------------------------------------------------
// H5Service class
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type H5WasmModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type H5WasmClass = any;

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  trace(message: string, ...args: unknown[]): void;
}

const noopLogger: Logger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {},
};

export class H5Service {
  private h5wasm: H5WasmModule = null;
  private DatasetClass: H5WasmClass = null;
  private AttributeClass: H5WasmClass = null;
  private fileId: bigint | null = null;
  private loadedPlugins = new Set<string>();
  private pluginsDir: string | null = null;
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger || noopLogger;
  }

  /**
   * Initialize h5wasm/node and open the file.
   */
  async init(
    filePath: string,
    extensionPath: string,
  ): Promise<void> {
    const t0 = performance.now();
    this.log.info(`[H5Service] Initializing for: ${filePath}`);
    // Workaround for Electron/VS Code environment detection issue in h5wasm
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    if (nav?.configurable) {
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
      });
    }

    let h5wasmPkg: H5WasmModule;
    try {
      h5wasmPkg = await import('h5wasm/node');
      this.h5wasm = await h5wasmPkg.ready;
    } finally {
      if (nav?.configurable) {
        Object.defineProperty(globalThis, 'navigator', nav);
      }
    }
    this.log.debug(`[H5Service] h5wasm WASM module ready (${(performance.now() - t0).toFixed(0)} ms)`);

    // Store class constructors for later use
    this.DatasetClass = h5wasmPkg.Dataset;
    this.AttributeClass = h5wasmPkg.Attribute;

    // Configure throwing error handler
    this.h5wasm.activate_throwing_error_handler();

    // NODERAWFS maps directly to the host filesystem, so we must use
    // a real temp directory for compression plugins — not Emscripten's
    // virtual FS (which doesn't exist in NODERAWFS mode).
    const tmpBase = mkdtempSync(join(tmpdir(), 'h5viewer-'));
    this.pluginsDir = join(tmpBase, 'plugins');
    mkdirSync(this.pluginsDir, { recursive: true });

    this.h5wasm.remove_plugin_search_path(0);
    this.h5wasm.insert_plugin_search_path(this.pluginsDir, 0);

    // Pre-load all compression plugins from the extension's .so files
    this.loadAllPlugins(extensionPath);

    // Open the file — NODERAWFS reads directly from host filesystem
    this.fileId = this.h5wasm.open(
      filePath,
      this.h5wasm.H5F_ACC_RDONLY,
      false,
    );

    this.log.info(`[H5Service] File opened in ${(performance.now() - t0).toFixed(0)} ms, plugins loaded: [${[...this.loadedPlugins].join(', ')}]`);
  }

  /**
   * Close the HDF5 file and release resources.
   */
  close(): void {
    this.log.info('[H5Service] Closing file');
    if (this.fileId !== null && this.h5wasm) {
      try {
        this.h5wasm.close_file(this.fileId);
      } catch {
        // Best-effort close
      }
      this.fileId = null;
    }

    // Clean up temp plugins directory
    if (this.pluginsDir) {
      try {
        const tmpBase = join(this.pluginsDir, '..');
        rmSync(tmpBase, { recursive: true });
        this.log.debug('[H5Service] Cleaned up temp plugins dir');
      } catch {
        // Best-effort cleanup
      }
      this.pluginsDir = null;
    }
  }

  /**
   * Reopen the file (e.g., after file change on disk).
   */
  async reopen(filePath: string): Promise<void> {
    const t0 = performance.now();
    this.log.info(`[H5Service] Reopening file: ${filePath}`);
    this.close();
    this.fileId = this.h5wasm.open(
      filePath,
      this.h5wasm.H5F_ACC_RDONLY,
      false,
    );
    this.log.info(`[H5Service] Reopened in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  /**
   * Get entity metadata at the given HDF5 path.
   * For groups, includes children (one level deep).
   */
  getEntity(path: string): unknown {
    this.ensureOpen();

    const entity = this.parseEntity(path, false) as Record<string, unknown>;

    // For .npy datasets: override shape/type with parsed NPY metadata
    if (entity.kind === 'dataset') {
      const name = (entity.name as string) || '';
      if (NPY_EXT.test(name)) {
        try {
          const npyResult = this.parseNpyDataset(path);
          entity.shape = npyResult.shape;
          entity.type = npyResult.dtype;
          (entity as Record<string, unknown>)._npyOverride = true;
        } catch {
          // If NPY parsing fails, show the raw uint8 dataset as-is
        }
      }
    }

    // For groups: also override children that are .npy datasets
    if (entity.kind === 'group' && Array.isArray(entity.children)) {
      for (const child of entity.children as Array<Record<string, unknown>>) {
        if (child.kind === 'dataset' && NPY_EXT.test(child.name as string || '')) {
          try {
            const npyResult = this.parseNpyDataset(child.path as string);
            child.shape = npyResult.shape;
            child.type = npyResult.dtype;
          } catch {
            // Keep original
          }
        }
      }
    }

    return entity;
  }

  /**
   * Get dataset value, optionally sliced.
   * selection format: "0,:,:" (comma-separated, : = all)
   */
  getValue(path: string, selection?: string): unknown {
    this.ensureOpen();

    const name = path.split('/').pop() || '';

    // .npy datasets: return the parsed NPY data instead of raw bytes
    if (NPY_EXT.test(name)) {
      try {
        const npyResult = this.parseNpyDataset(path);
        return npyResult.value;
      } catch {
        // Fall through to raw read
      }
    }

    const dataset = new this.DatasetClass(this.fileId!, path);

    // Ensure plugins are loaded for compressed datasets
    this.ensurePluginsForDataset(path);

    let value: unknown;
    if (!selection) {
      value = dataset.value;
    } else {
      const shape = dataset.shape;
      if (!shape) {
        value = dataset.value;
      } else {
        const selectionMembers = selection.split(',');
        const ranges = selectionMembers.map(
          (member: string, i: number): [number, number] => {
            if (member === ':') {
              return [0, shape[i]];
            }
            return [Number(member), Number(member) + 1];
          },
        );
        value = dataset.slice(ranges);
      }
    }

    return serializeValue(value);
  }

  /**
   * Parse a .npy blob dataset. Reads raw bytes and parses the NPY header + data.
   */
  private parseNpyDataset(path: string): import('./npy-parser.js').NpyResult {
    const dataset = new this.DatasetClass(this.fileId!, path);
    this.ensurePluginsForDataset(path);
    const raw = dataset.value;
    const buf = Buffer.from(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer));
    return parseNpy(buf);
  }

  /**
   * Get all attribute values for an entity.
   */
  getAttrValues(path: string): Record<string, unknown> {
    this.ensureOpen();
    const names = this.h5wasm.get_attribute_names(this.fileId!, path);
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const attr = new this.AttributeClass(this.fileId!, path, name);
      result[name] = serializeValue(attr.json_value);
    }
    return result;
  }

  /**
   * Get all descendant paths for search functionality.
   */
  getSearchablePaths(rootPath: string): string[] {
    this.ensureOpen();
    return this.h5wasm
      .get_names(this.fileId!, rootPath, true)
      .map((p: string) => `${rootPath}${p}`);
  }

  /**
   * Read first N bytes of a dataset for magic detection.
   */
  private readFirstBytes(path: string, maxBytes: number): Uint8Array | null {
    try {
      const dataset = new this.DatasetClass(this.fileId!, path);
      const shape = dataset.shape;
      if (!shape || shape.length === 0) return null;

      // Only read from 1D uint8-like datasets
      if (shape.length === 1 && shape[0] >= maxBytes) {
        const slice = dataset.slice([[0, maxBytes]]);
        if (slice instanceof Uint8Array) return slice;
        if (slice instanceof Int8Array) return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
      }

      // Fallback: read full value if small enough
      const totalElements = shape.reduce((a: number, b: number) => a * b, 1);
      if (totalElements <= maxBytes * 2) {
        const val = dataset.value;
        if (val instanceof Uint8Array) return val.subarray(0, maxBytes);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Scan the file tree for datasets that look like audio data.
   * Uses magic bytes detection (priority) + extension name (fallback).
   */
  async getAudioHints(): Promise<AudioHint[]> {
    this.ensureOpen();
    const hints: AudioHint[] = [];
    const allPaths = this.h5wasm.get_names(this.fileId!, '/', true) as string[];

    for (const relPath of allPaths) {
      const path = `/${relPath}`;
      try {
        const kind = this.h5wasm.get_type(this.fileId!, path) as number;
        if (kind !== this.h5wasm.H5G_DATASET) continue;

        const name = relPath.split('/').pop() || relPath;
        const meta = this.h5wasm.get_dataset_metadata(this.fileId!, path) as Metadata;
        const totalBytes = (meta.shape || []).reduce((a: number, b: number) => a * b, 1) * meta.size;

        // Try magic bytes detection on 1D byte arrays
        const firstBytes = this.readFirstBytes(path, DETECTION_SAMPLE_SIZE);
        if (firstBytes) {
          const detection = await detectContentType(name, firstBytes);
          if (detection.category === 'audio') {
            const hint = makeEncodedBlobHint(path, name, totalBytes);
            hint.detectedMime = detection.mime;
            hint.detectedLabel = detection.label;
            hint.mismatchWarning = detection.mismatchWarning;
            hints.push(hint);
            continue;
          }
        }

        // Fallback: check extension name
        if (isAudioByName(name)) {
          const hint = makeEncodedBlobHint(path, name, totalBytes);
          // Try magic detection for additional info
          if (firstBytes) {
            const detection = await detectContentType(name, firstBytes);
            hint.detectedMime = detection.mime;
            hint.detectedLabel = detection.label;
            hint.mismatchWarning = detection.mismatchWarning;
          }
          hints.push(hint);
          continue;
        }

        // Check PCM array shape heuristic
        const dtype = parseDType(meta);
        const dtypeClass = (dtype as Record<string, string>)?.class;
        if (isAudioByShape(meta.shape, dtypeClass)) {
          const attrValues = this.getAttrValues(path);
          hints.push(makePcmArrayHint(path, name, meta.shape, dtypeClass, attrValues));
        }
      } catch {
        // Skip
      }
    }

    this.log.debug(`[H5Service] Found ${hints.length} audio datasets`);
    return hints;
  }

  /**
   * Read audio data for a specific dataset.
   */
  getAudioData(path: string): unknown {
    this.ensureOpen();

    const name = path.split('/').pop() || path;
    const meta = this.h5wasm.get_dataset_metadata(this.fileId!, path) as Metadata;

    // Check if it's an encoded blob (1D byte array with audio magic or name)
    const dtype = parseDType(meta);
    const dtypeClass = (dtype as Record<string, string>)?.class;
    const isBlob = meta.shape?.length === 1 && (dtypeClass === 'Integer') && meta.size === 1;

    if (isBlob || isAudioByName(name)) {
      const dataset = new this.DatasetClass(this.fileId!, path);
      const value = dataset.value;
      let bytes: number[];
      if (value instanceof Uint8Array) bytes = Array.from(value);
      else if (Array.isArray(value)) bytes = value as number[];
      else bytes = Array.from(new Uint8Array(value as ArrayBuffer));
      return { type: 'encoded', data: bytes };
    }

    // PCM array
    const dataset = new this.DatasetClass(this.fileId!, path);
    const value = dataset.value;
    const serialized = serializeValue(value);
    const { numChannels, numSamples, channelFirst } = inferAudioLayout(meta.shape);
    const attrValues = this.getAttrValues(path);
    const sampleRate = extractSampleRate(attrValues) || 0;

    return { type: 'pcm', data: serialized, sampleRate, numChannels, numSamples, channelFirst };
  }

  /**
   * Scan for JSON datasets. Uses magic bytes + extension detection.
   */
  async getJsonHints(): Promise<import('./models.js').JsonHint[]> {
    this.ensureOpen();
    const hints: import('./models.js').JsonHint[] = [];
    const allPaths = this.h5wasm.get_names(this.fileId!, '/', true) as string[];

    for (const relPath of allPaths) {
      const path = `/${relPath}`;
      try {
        const kind = this.h5wasm.get_type(this.fileId!, path) as number;
        if (kind !== this.h5wasm.H5G_DATASET) continue;
        const name = relPath.split('/').pop() || relPath;

        const meta = this.h5wasm.get_dataset_metadata(this.fileId!, path) as Metadata;
        const totalBytes = (meta.shape || []).reduce((a: number, b: number) => a * b, 1) * meta.size;

        // Try magic detection on byte arrays
        const firstBytes = this.readFirstBytes(path, DETECTION_SAMPLE_SIZE);
        if (firstBytes) {
          const detection = await detectContentType(name, firstBytes);
          if (detection.category === 'json') {
            hints.push({
              path, name, dataSize: totalBytes,
              detectedLabel: detection.label,
              mismatchWarning: detection.mismatchWarning,
            });
            continue;
          }
        }

        // Fallback: extension check
        if (JSON_EXT.test(name)) {
          hints.push({ path, name, dataSize: totalBytes });
          continue;
        }

        // Also detect JSON from string-type datasets with .json name
        if (meta.type === 3 /* H5T_STRING */ && JSON_EXT.test(name)) {
          hints.push({ path, name, dataSize: totalBytes });
        }
      } catch {
        // skip
      }
    }
    this.log.debug(`[H5Service] Found ${hints.length} JSON datasets`);
    return hints;
  }

  /**
   * Read a .json dataset, parse it, and return the formatted JSON string.
   */
  getJsonData(path: string): { json: string; parsed: unknown } {
    this.ensureOpen();
    const dataset = new this.DatasetClass(this.fileId!, path);
    this.ensurePluginsForDataset(path);
    const raw = dataset.value;

    let str: string;
    if (typeof raw === 'string') {
      str = raw;
    } else if (raw instanceof Uint8Array) {
      str = new TextDecoder().decode(raw);
    } else if (Array.isArray(raw)) {
      // Array of char codes or strings
      str = (raw as Array<string | number>).map(v =>
        typeof v === 'number' ? String.fromCharCode(v) : v,
      ).join('');
    } else {
      str = String(raw);
    }

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(str);
      const formatted = JSON.stringify(parsed, null, 2);
      return { json: formatted, parsed };
    } catch {
      // Not valid JSON — return as-is
      return { json: str, parsed: null };
    }
  }

  /**
   * Detect the content type of a dataset using magic bytes + extension.
   * Returns { category, mime, ext, label, mismatchWarning? }
   */
  async detectDatasetType(path: string): Promise<unknown> {
    this.ensureOpen();
    const name = path.split('/').pop() || path;
    const firstBytes = this.readFirstBytes(path, DETECTION_SAMPLE_SIZE);
    if (firstBytes) {
      return detectContentType(name, firstBytes);
    }
    // No bytes available — fall back to extension only
    const { detectByExtension } = await import('./magic-detect.js');
    return detectByExtension(name) || { category: 'unknown', mime: '', ext: '', label: 'Unknown', detectedBy: 'extension' };
  }

  // ---- Private helpers ----

  private ensureOpen(): void {
    if (this.fileId === null) {
      throw new Error('HDF5 file is not open');
    }
  }

  private parseEntity(path: string, isChild: boolean): unknown {
    const fileId = this.fileId!;
    const baseEntity = {
      name: getNameFromPath(path) || (path === '/' ? '' : path),
      path,
      attributes: [] as unknown[],
    };

    const kind = this.h5wasm.get_type(fileId, path) as number;

    // H5G_GROUP
    if (kind === this.h5wasm.H5G_GROUP) {
      const attrs = this.parseAttributes(path);
      const baseGroup = {
        ...baseEntity,
        kind: EntityKind.Group,
        attributes: attrs,
      };

      if (isChild) {
        return baseGroup;
      }

      const childrenNames = this.h5wasm.get_names(
        fileId,
        path,
        false,
      ) as string[];
      return {
        ...baseGroup,
        children: childrenNames.map((childName: string) =>
          this.parseEntity(buildEntityPath(path, childName), true),
        ),
      };
    }

    // H5G_DATASET
    if (kind === this.h5wasm.H5G_DATASET) {
      const metadata = this.h5wasm.get_dataset_metadata(
        fileId,
        path,
      ) as Metadata;
      const { chunks, maxshape, shape, virtual_sources, ...rawType } = metadata;

      return {
        ...baseEntity,
        kind: EntityKind.Dataset,
        shape,
        type: parseDType(metadata),
        chunks: chunks ?? undefined,
        filters: this.h5wasm.get_dataset_filters(fileId, path),
        virtualSources: parseVirtualSources(metadata),
        attributes: this.parseAttributes(path),
        rawType,
      };
    }

    // H5G_TYPE
    if (kind === this.h5wasm.H5G_TYPE) {
      const metadata = this.h5wasm.get_datatype_metadata(
        fileId,
        path,
      ) as Metadata;
      const { chunks, maxshape, shape, ...rawType } = metadata;

      return {
        ...baseEntity,
        kind: EntityKind.Datatype,
        type: parseDType(metadata),
        attributes: this.parseAttributes(path),
        rawType,
      };
    }

    // H5G_LINK (soft link)
    if (kind === this.h5wasm.H5G_LINK) {
      const target = this.h5wasm.get_symbolic_link(fileId, path) as string;
      return {
        ...baseEntity,
        kind: EntityKind.Unresolved,
        link: { class: 'Soft', path: target },
      };
    }

    // H5G_UDLINK (external link)
    if (kind === this.h5wasm.H5G_UDLINK) {
      const extLink = this.h5wasm.get_external_link(fileId, path) as {
        filename: string;
        obj_path: string;
      };
      return {
        ...baseEntity,
        kind: EntityKind.Unresolved,
        link: { class: 'External', file: extLink.filename, path: extLink.obj_path },
      };
    }

    // Unknown
    return {
      ...baseEntity,
      kind: EntityKind.Unresolved,
    };
  }

  private parseAttributes(path: string): unknown[] {
    const fileId = this.fileId!;
    const names = this.h5wasm.get_attribute_names(fileId, path) as string[];

    return names.map((name: string) => {
      const metadata = this.h5wasm.get_attribute_metadata(
        fileId,
        path,
        name,
      ) as Metadata;
      return {
        name,
        shape: metadata.shape,
        type: parseDType(metadata),
      };
    });
  }

  private ensurePluginsForDataset(path: string): void {
    if (!this.pluginsDir) return;

    try {
      const filters = this.h5wasm.get_dataset_filters(
        this.fileId!,
        path,
      ) as Array<{ id: number; name: string }>;
      for (const f of filters) {
        const pluginName = PLUGINS_BY_FILTER_ID[f.id];
        if (pluginName && !this.loadedPlugins.has(pluginName)) {
          const pluginPath = join(this.pluginsDir, `libH5Z${pluginName}.so`);
          if (!existsSync(pluginPath)) {
            this.log.warn(
              `[H5Service] Plugin ${pluginName} not available for filter ${f.name}`,
            );
          }
        }
      }
    } catch {
      // Best effort — don't fail for filter check
    }
  }

  private loadAllPlugins(extensionPath: string): void {
    if (!this.pluginsDir) return;

    for (const [name, relativePath] of Object.entries(PLUGINS)) {
      try {
        const destPath = join(this.pluginsDir, `libH5Z${name}.so`);
        if (existsSync(destPath)) {
          this.loadedPlugins.add(name);
          continue;
        }

        const srcPath = join(extensionPath, 'out', relativePath);
        if (!existsSync(srcPath)) {
          continue; // Plugin file not found in extension — skip
        }

        copyFileSync(srcPath, destPath);
        this.loadedPlugins.add(name);
        this.log.debug(`[H5Service] Loaded plugin: ${name}`);
      } catch (err) {
        this.log.warn(`[H5Service] Failed to load plugin ${name}:`, err);
      }
    }
  }
}

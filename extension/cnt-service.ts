/**
 * Unified CNT file service.
 *
 * Auto-detects Neuroscan vs ANT Neuro format from file header,
 * delegates to the appropriate parser, and exposes the same RPC
 * interface as H5Service / MatService.
 *
 * Data model mapping:
 *   /                      → Group (root)
 *   /info/                 → Group (recording metadata)
 *   /channels/             → Group
 *   /channels/<label>      → Dataset (1D float64, physical µV)
 *   /events                → Dataset (event table)
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { Logger } from './h5-service.js';
import type { AudioHint } from './models.js';
import { NeuroscanParser, type NeuroscanHeader } from './cnt-neuroscan.js';
import { AntParser, type AntHeader } from './cnt-ant.js';

// DType / Entity constants — must match h5-service.ts
const DTypeClass = {
  Float: 'Float',
  Integer: 'Integer',
  String: 'String',
  Unknown: 'Unknown',
} as const;

const EntityKind = {
  Group: 'group',
  Dataset: 'dataset',
} as const;

export type CntFormat = 'neuroscan' | 'ant-neuro';

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export function detectCntFormat(filePath: string): CntFormat {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    readSync(fd, buf, 0, 12, 0);
    const magic = buf.toString('ascii', 0, 4);
    if (magic === 'RIFF' || magic === 'RF64') {
      const formType = buf.toString('ascii', 8, 12);
      if (formType === 'CNT ') {
        return 'ant-neuro';
      }
    }
    return 'neuroscan';
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// VNode (same as mat-service.ts)
// ---------------------------------------------------------------------------

interface VNode {
  name: string;
  path: string;
  kind: string;
  children?: VNode[];
  shape?: number[];
  type?: unknown;
  value?: unknown;
  attributes?: Array<{ name: string; shape: number[] | null; type: unknown }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CntService
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {},
};

export class CntService {
  private log: Logger;
  private format: CntFormat | null = null;
  private neuroscanParser: NeuroscanParser | null = null;
  private antParser: AntParser | null = null;
  private root: VNode | null = null;
  private nodeMap = new Map<string, VNode>();

  // Lazy-loaded channel data cache
  private channelDataCache = new Map<string, Float64Array>();

  constructor(logger?: Logger) {
    this.log = logger || noopLogger;
  }

  async init(
    filePath: string,
    onProgress?: (message: string) => void,
  ): Promise<CntFormat> {
    const t0 = performance.now();
    const { size } = statSync(filePath);
    const sizeMB = (size / 1024 / 1024).toFixed(1);

    onProgress?.('Detecting CNT format...');
    this.format = detectCntFormat(filePath);
    this.log.info(`[CntService] Detected format: ${this.format} for ${filePath} (${sizeMB} MB)`);

    if (this.format === 'neuroscan') {
      onProgress?.('Parsing Neuroscan CNT header...');
      this.neuroscanParser = new NeuroscanParser(this.log);
      const header = this.neuroscanParser.open(filePath);
      this.buildTreeFromNeuroscan(header);
    } else {
      onProgress?.('Parsing ANT Neuro CNT (RIFF + RAW3)...');
      this.antParser = new AntParser(this.log);
      const header = this.antParser.open(filePath);
      this.buildTreeFromAnt(header);
    }

    this.log.info(`[CntService] Ready in ${(performance.now() - t0).toFixed(0)} ms, nodes: ${this.nodeMap.size}`);
    onProgress?.('Ready');

    return this.format;
  }

  close(): void {
    this.neuroscanParser?.close();
    this.antParser?.close();
    this.neuroscanParser = null;
    this.antParser = null;
    this.root = null;
    this.nodeMap.clear();
    this.channelDataCache.clear();
    this.log.info('[CntService] Closed');
  }

  getEntity(path: string): unknown {
    const node = this.nodeMap.get(path);
    if (!node) throw new Error(`Entity not found: ${path}`);

    if (node.kind === EntityKind.Group && node.children) {
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
          ...(c.kind === EntityKind.Dataset ? { shape: c.shape, type: c.type, rawType: {} } : {}),
        })),
      };
    }

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

  getValue(path: string, _selection?: string): unknown {
    const node = this.nodeMap.get(path);
    if (!node || node.kind !== EntityKind.Dataset) {
      throw new Error(`Dataset not found: ${path}`);
    }

    // For channel datasets, load data on demand
    if (node._channelIndex !== undefined) {
      return this.getChannelData(node._channelIndex as number, node.shape![0]);
    }

    // For other datasets (events, scalar metadata), return stored value
    return node.value;
  }

  getAttrValues(path: string): Record<string, unknown> {
    const node = this.nodeMap.get(path);
    if (!node) throw new Error(`Entity not found: ${path}`);
    return (node._attrValues as Record<string, unknown>) || {};
  }

  getSearchablePaths(_rootPath: string): string[] {
    return Array.from(this.nodeMap.keys()).filter((p) => p !== '/');
  }

  getAudioHints(): AudioHint[] {
    // CNT files are EEG data — not typically audio, but each channel is a 1D signal
    // Don't auto-detect as audio since EEG channels aren't meant for audio playback
    return [];
  }

  getAudioData(_path: string): unknown {
    throw new Error('Audio playback is not supported for CNT files');
  }

  getJsonHints(): import('./models.js').JsonHint[] {
    return [];
  }

  getJsonData(_path: string): unknown {
    throw new Error('JSON viewing is not supported for CNT files');
  }

  // ---------------------------------------------------------------------------
  // Private: Channel data loading (on-demand)
  // ---------------------------------------------------------------------------

  private getChannelData(channelIndex: number, nSamples: number): unknown {
    const cacheKey = `ch${channelIndex}`;
    let data = this.channelDataCache.get(cacheKey);
    if (!data) {
      const t0 = performance.now();
      if (this.neuroscanParser) {
        data = this.neuroscanParser.readChannel(channelIndex);
      } else if (this.antParser) {
        data = this.antParser.readChannel(channelIndex);
      } else {
        throw new Error('No parser available');
      }
      this.channelDataCache.set(cacheKey, data);
      this.log.debug(`[CntService] Loaded channel ${channelIndex} (${nSamples} samples) in ${(performance.now() - t0).toFixed(0)} ms`);
    }

    return {
      __typedArray: true,
      type: 'Float64Array',
      data: Array.from(data),
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Tree building
  // ---------------------------------------------------------------------------

  private buildTreeFromNeuroscan(h: NeuroscanHeader): void {
    const floatType = { class: DTypeClass.Float, size: 64, endianness: 'little-endian' };
    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };
    const intType = { class: DTypeClass.Integer, signed: true, size: 32, endianness: 'little-endian' };
    const duration = h.numSamples / h.sampleRate;

    // Root
    this.root = this.makeGroup('', '/', []);
    this.root._attrValues = {
      format: 'Neuroscan CNT',
      revision: h.revision,
      data_format: h.dataFormat,
    };
    this.root.attributes = [
      { name: 'format', shape: null, type: strType },
      { name: 'revision', shape: null, type: strType },
      { name: 'data_format', shape: null, type: strType },
    ];

    // /info group
    const info = this.makeGroup('info', '/info', [
      this.makeDataset('patient_id', '/info/patient_id', [], strType, h.patientId),
      this.makeDataset('sample_rate', '/info/sample_rate', [], intType, h.sampleRate),
      this.makeDataset('num_samples', '/info/num_samples', [], intType, h.numSamples),
      this.makeDataset('num_channels', '/info/num_channels', [], intType, h.nChannels),
      this.makeDataset('duration_sec', '/info/duration_sec', [], floatType, parseFloat(duration.toFixed(2))),
    ]);

    // /channels group
    const channelNodes: VNode[] = [];
    for (let i = 0; i < h.channels.length; i++) {
      const ch = h.channels[i];
      const label = ch.label || `ch${i}`;
      const chNode = this.makeDataset(label, `/channels/${label}`, [h.numSamples], floatType, undefined);
      chNode._channelIndex = i;
      chNode.attributes = [
        { name: 'unit', shape: null, type: strType },
        { name: 'x_coord', shape: null, type: floatType },
        { name: 'y_coord', shape: null, type: floatType },
      ];
      chNode._attrValues = { unit: 'µV', x_coord: ch.xCoord, y_coord: ch.yCoord };
      channelNodes.push(chNode);
    }
    const channels = this.makeGroup('channels', '/channels', channelNodes);

    // /events dataset
    const eventsNode = this.makeEventsDataset(
      h.events.map((e) => ({ code: String(e.stimType), sampleIndex: e.sampleIndex, duration: 0 })),
      h.sampleRate,
    );

    this.root.children = [info, channels, eventsNode];
    this.registerAll(this.root);
  }

  private buildTreeFromAnt(h: AntHeader): void {
    const floatType = { class: DTypeClass.Float, size: 64, endianness: 'little-endian' };
    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };
    const intType = { class: DTypeClass.Integer, signed: true, size: 32, endianness: 'little-endian' };
    const duration = h.nSamples / h.sampleRate;

    // Root
    this.root = this.makeGroup('', '/', []);
    this.root._attrValues = {
      format: 'ANT Neuro CNT',
      file_version: `${h.fileVersionMajor}.${h.fileVersionMinor}`,
    };
    this.root.attributes = [
      { name: 'format', shape: null, type: strType },
      { name: 'file_version', shape: null, type: strType },
    ];

    // /info group
    const info = this.makeGroup('info', '/info', [
      this.makeDataset('sample_rate', '/info/sample_rate', [], intType, h.sampleRate),
      this.makeDataset('num_samples', '/info/num_samples', [], intType, h.nSamples),
      this.makeDataset('num_channels', '/info/num_channels', [], intType, h.nChannels),
      this.makeDataset('duration_sec', '/info/duration_sec', [], floatType, parseFloat(duration.toFixed(2))),
      this.makeDataset('epoch_length', '/info/epoch_length', [], intType, h.epochLength),
    ]);

    // /channels group
    const channelNodes: VNode[] = [];
    for (let i = 0; i < h.channels.length; i++) {
      const ch = h.channels[i];
      const label = ch.label || `ch${i}`;
      const chNode = this.makeDataset(label, `/channels/${label}`, [h.nSamples], floatType, undefined);
      chNode._channelIndex = i;
      chNode.attributes = [
        { name: 'unit', shape: null, type: strType },
        { name: 'type', shape: null, type: strType },
        { name: 'reference', shape: null, type: strType },
      ];
      chNode._attrValues = { unit: ch.unit, type: ch.type, reference: ch.refLabel };
      channelNodes.push(chNode);
    }
    const channels = this.makeGroup('channels', '/channels', channelNodes);

    // /events dataset
    const eventsNode = this.makeEventsDataset(h.triggers, h.sampleRate);

    this.root.children = [info, channels, eventsNode];
    this.registerAll(this.root);
  }

  private makeEventsDataset(
    events: Array<{ code: string; sampleIndex: number; duration: number }>,
    sampleRate: number,
  ): VNode {
    const strType = { class: DTypeClass.String, charSet: 'UTF-8', strPad: 'null-terminated' };

    if (events.length === 0) {
      return this.makeDataset('events', '/events', [0], strType, []);
    }

    // Store events as a string array of "time_sec code duration"
    const eventStrings = events.map((e) => {
      const timeSec = (e.sampleIndex / sampleRate).toFixed(3);
      return `${timeSec}s  code=${e.code}  dur=${e.duration}`;
    });

    return this.makeDataset('events', '/events', [events.length], strType, eventStrings);
  }

  // ---------------------------------------------------------------------------
  // VNode helpers
  // ---------------------------------------------------------------------------

  private makeGroup(name: string, path: string, children: VNode[]): VNode {
    return { name, path, kind: EntityKind.Group, children, attributes: [] };
  }

  private makeDataset(name: string, path: string, shape: number[], type: unknown, value: unknown): VNode {
    return { name, path, kind: EntityKind.Dataset, shape, type, value, attributes: [] };
  }

  private registerAll(node: VNode): void {
    this.nodeMap.set(node.path, node);
    if (node.children) {
      for (const child of node.children) {
        this.registerAll(child);
      }
    }
  }
}

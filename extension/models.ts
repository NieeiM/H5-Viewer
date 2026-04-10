import { type ExportFormat } from '@h5web/app';

// ---- Message types ----

export enum MessageType {
  Ready = 'Ready',
  FileInfo = 'FileInfo',
  Export = 'Export',
  RpcRequest = 'RpcRequest',
  RpcResponse = 'RpcResponse',
  FileChanged = 'FileChanged',
  LoadingProgress = 'LoadingProgress',
}

export interface FileInfo {
  name: string;
  size: number;
  format?: 'hdf5' | 'mat-v5' | 'mat-v7' | 'mat-v73' | 'cnt-neuroscan' | 'cnt-ant';
  errorMessage?: string;
}

export interface LoadingProgress {
  message: string;
  /** 0-100, or -1 for indeterminate */
  percent: number;
  /** File name being loaded */
  fileName?: string;
  /** File size in bytes */
  fileSize?: number;
}

export interface Export {
  format: ExportFormat;
  name: string;
  payload: string;
}

// ---- RPC protocol for on-demand data loading ----

export type RpcMethod =
  | 'getEntity'
  | 'getValue'
  | 'getAttrValues'
  | 'getSearchablePaths'
  | 'getAudioHints'
  | 'getAudioData';

// ---- Audio types ----

export type AudioDatasetType = 'encoded-blob' | 'pcm-array';

export interface AudioHint {
  /** HDF5 path to the dataset */
  path: string;
  /** Display name */
  name: string;
  /** How the data should be interpreted */
  audioType: AudioDatasetType;
  /** Sample rate in Hz (only for pcm-array, 0 if unknown) */
  sampleRate: number;
  /** Number of channels (only for pcm-array, 0 if unknown) */
  numChannels: number;
  /** Total number of samples per channel (only for pcm-array) */
  numSamples: number;
  /** Dataset size in bytes (for encoded blobs) or total element count */
  dataSize: number;
  /** Warning message if the data is very large */
  warning?: string;
}

export interface RpcRequest {
  id: number;
  method: RpcMethod;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

// ---- Union message type ----

export type Message =
  | { type: MessageType.Ready }
  | { type: MessageType.FileInfo; data: FileInfo }
  | { type: MessageType.Export; data: Export }
  | { type: MessageType.RpcRequest; data: RpcRequest }
  | { type: MessageType.RpcResponse; data: RpcResponse }
  | { type: MessageType.FileChanged }
  | { type: MessageType.LoadingProgress; data: LoadingProgress };

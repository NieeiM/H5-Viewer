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
  format?: 'hdf5' | 'mat-v5' | 'mat-v7' | 'mat-v73';
  errorMessage?: string;
}

export interface LoadingProgress {
  message: string;
  /** 0-100, or -1 for indeterminate */
  percent: number;
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
  | 'getSearchablePaths';

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

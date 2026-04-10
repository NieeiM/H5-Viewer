/**
 * Remote HDF5 DataProvider API.
 *
 * Runs in the Webview (browser context). Communicates with the Extension Host
 * via VS Code's postMessage RPC to request entity metadata, dataset values,
 * and attribute values on demand.
 */

import {
  DataProviderApi,
  type ExportFormat,
  type ExportURL,
  type ProvidedEntity,
  type ValuesStoreParams,
} from '@h5web/app';
import type { WebviewApi } from 'vscode-webview';

import { MessageType, type RpcMethod, type RpcResponse } from '../extension/models.js';

// ---------------------------------------------------------------------------
// TypedArray reconstruction map
// ---------------------------------------------------------------------------

const TYPED_ARRAY_CONSTRUCTORS: Record<string, TypedArrayConstructor | BigIntArrayConstructor> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

type TypedArrayConstructor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor;

type BigIntArrayConstructor = BigInt64ArrayConstructor | BigUint64ArrayConstructor;

// ---------------------------------------------------------------------------
// Value deserialization — reconstruct TypedArrays from plain objects
// ---------------------------------------------------------------------------

function deserializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // Reconstruct BigInt scalars
    if (obj.__bigint === true && typeof obj.value === 'string') {
      return BigInt(obj.value as string);
    }

    // Reconstruct TypedArrays
    if (obj.__typedArray === true && typeof obj.type === 'string') {
      const Ctor = TYPED_ARRAY_CONSTRUCTORS[obj.type as string];
      if (!Ctor) return obj;
      const data = obj.data as Array<number | string>;

      if (obj.type === 'BigInt64Array' || obj.type === 'BigUint64Array') {
        return (Ctor as BigIntArrayConstructor).from(
          data.map((v) => BigInt(v as string)),
        );
      }
      return (Ctor as TypedArrayConstructor).from(data as number[]);
    }
  }

  // Recurse into arrays
  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }

  return value;
}

// ---------------------------------------------------------------------------
// RPC Client — sends requests to extension host via postMessage
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private disposed = false;

  constructor(private readonly vscode: WebviewApi<unknown>) {
    // Listen for RPC responses from the extension host
    window.addEventListener('message', this.handleMessage);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('message', this.handleMessage);
    // Reject all pending requests
    for (const [, p] of this.pending) {
      p.reject(new Error('RPC client disposed'));
    }
    this.pending.clear();
  }

  async call(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) {
      throw new Error('RPC client is disposed');
    }

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      this.vscode.postMessage({
        type: MessageType.RpcRequest,
        data: { id, method, params },
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method} (id=${id})`));
        }
      }, 30_000);
    });
  }

  private handleMessage = (evt: MessageEvent): void => {
    const msg = evt.data;
    if (msg?.type !== MessageType.RpcResponse) return;

    const { id, result, error } = msg.data as RpcResponse;
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  };
}

// ---------------------------------------------------------------------------
// RemoteH5Api — DataProviderApi backed by RPC to extension host
// ---------------------------------------------------------------------------

interface Entity {
  path: string;
  attributes: Array<{ name: string }>;
}

type AttributeValues = Record<string, unknown>;
type BuiltInExporter = () => string;

interface Dataset {
  path: string;
  name: string;
}

export class RemoteH5Api extends DataProviderApi {
  constructor(
    filepath: string,
    private readonly rpc: RpcClient,
    private readonly vscodeApi: WebviewApi<unknown>,
  ) {
    super(filepath);
  }

  public override async getEntity(path: string): Promise<ProvidedEntity> {
    return this.rpc.call('getEntity', { path }) as Promise<ProvidedEntity>;
  }

  public override async getValue(
    params: ValuesStoreParams,
    _abortSignal?: AbortSignal,
  ): Promise<unknown> {
    const { dataset, selection } = params;
    const raw = await this.rpc.call('getValue', {
      path: dataset.path,
      selection,
    });
    return deserializeValue(raw);
  }

  public override async getAttrValues(entity: Entity): Promise<AttributeValues> {
    const raw = await this.rpc.call('getAttrValues', { path: entity.path });
    // Deserialize any typed array values in attributes
    const result: AttributeValues = {};
    const obj = raw as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      result[key] = deserializeValue(val);
    }
    return result;
  }

  public override async getSearchablePaths(root: string): Promise<string[]> {
    return (await this.rpc.call('getSearchablePaths', { path: root })) as string[];
  }

  public override getExportURL(
    format: ExportFormat,
    dataset: Dataset,
    _selection?: string,
    builtInExporter?: BuiltInExporter,
  ): ExportURL | undefined {
    if (!builtInExporter) {
      return undefined;
    }

    const vscodeApi = this.vscodeApi;

    return async () => {
      const payload = builtInExporter();

      // Send payload to extension host for saving
      vscodeApi.postMessage({
        type: MessageType.Export,
        data: { format, name: dataset.name, payload },
      });

      return new Blob(); // non-falsy to signal success
    };
  }
}

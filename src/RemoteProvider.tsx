/**
 * React component that wraps RemoteH5Api into a DataProvider.
 */

import { DataProvider } from '@h5web/app';
import { useEffect, useMemo, type PropsWithChildren } from 'react';

import { RemoteH5Api, type PathAccessCallback, type RpcClient } from './remote-api';
import { vscode } from './vscode-api';

interface Props {
  filepath: string;
  rpc: RpcClient;
  onPathAccess?: PathAccessCallback;
}

function RemoteProvider(props: PropsWithChildren<Props>) {
  const { filepath, rpc, onPathAccess, children } = props;

  const api = useMemo(() => {
    return new RemoteH5Api(filepath, rpc, vscode);
  }, [filepath, rpc]);

  // Wire up the path access callback
  useEffect(() => {
    console.log('[H5V] RemoteProvider: wiring onPathAccess, hasCallback:', !!onPathAccess);
    api.onPathAccess = onPathAccess || null;
    return () => { api.onPathAccess = null; };
  }, [api, onPathAccess]);

  return (
    <DataProvider api={api}>
      {children}
    </DataProvider>
  );
}

export default RemoteProvider;

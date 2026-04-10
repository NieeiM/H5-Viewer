/**
 * React component that wraps RemoteH5Api into a DataProvider.
 */

import { DataProvider } from '@h5web/app';
import { useMemo, type PropsWithChildren } from 'react';

import { RemoteH5Api, type RpcClient } from './remote-api';
import { vscode } from './vscode-api';

interface Props {
  filepath: string;
  rpc: RpcClient;
}

function RemoteProvider(props: PropsWithChildren<Props>) {
  const { filepath, rpc, children } = props;

  const api = useMemo(() => {
    return new RemoteH5Api(filepath, rpc, vscode);
  }, [filepath, rpc]);

  return (
    <DataProvider api={api}>
      {children}
    </DataProvider>
  );
}

export default RemoteProvider;

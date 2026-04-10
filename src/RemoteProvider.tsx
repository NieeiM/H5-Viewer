/**
 * React component that wraps RemoteH5Api into a DataProvider.
 */

import { App, DataProvider } from '@h5web/app';
import { useMemo, type PropsWithChildren } from 'react';

import { RemoteH5Api, RpcClient } from './remote-api';
import { vscode } from './vscode-api';

interface Props {
  filepath: string;
}

function RemoteProvider(props: PropsWithChildren<Props>) {
  const { filepath, children } = props;

  const api = useMemo(() => {
    const rpc = new RpcClient(vscode);
    return new RemoteH5Api(filepath, rpc, vscode);
  }, [filepath]);

  return (
    <DataProvider api={api}>
      {children}
    </DataProvider>
  );
}

export default RemoteProvider;

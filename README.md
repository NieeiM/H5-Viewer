# H5 Viewer

**Visualize HDF5 files directly in VS Code** — optimized for Remote SSH with on-demand data loading.

[Chinese / 中文文档](./README.zh-CN.md)

![Demo](./assets/vscode-h5web.gif)

## Key Features

- **Line plots** — 1D datasets with error bars, auxiliary signals, and CSV export
- **Heatmaps** — 2D datasets with multiple colormaps, complex number support, and axis controls
- **Tables** — Matrix view for numerical and compound datasets
- **RGB images** — Direct visualization of RGB datasets
- **3D slicing** — Navigate slices of 3D+ datasets interactively
- **NeXus support** — Automatic interpretation of NXdata groups and axes
- **Metadata inspector** — Attributes, chunk layout, compression filters, and data types
- **Search** — Find entities across the entire file tree

## Remote Optimization

This is a fork of [vscode-h5web](https://github.com/silx-kit/vscode-h5web) with a redesigned architecture for remote development.

### The Problem

The original extension transfers **the entire HDF5 file** from the remote server to the local browser for parsing. A 500 MB file means 500 MB of network transfer before anything renders. Files over 2 GB cannot be opened at all.

### The Solution

H5 Viewer runs the HDF5 parser (h5wasm) on the **remote server** (Extension Host) and sends only the requested data slices to the local webview via VS Code's message passing. The file never leaves the server.

| | Original | H5 Viewer |
|---|---|---|
| Open a 500 MB file | Transfer 500 MB, then parse | Parse on server, transfer ~10 KB metadata |
| Switch dataset | Instant (in memory) | RPC request (~ms latency) |
| File size limit | 2 GB | **None** |
| Remote experience | Slow | Fast |

## Supported File Extensions

The viewer opens automatically for: `.h5`, `.hdf`, `.hdf5`, `.hf5`, `.nx`, `.nxs`, `.nx5`, `.nexus`, `.cxi`, `.nc`, `.nc4`, `.loom`, `.jld2`, `.h5ebsd`, `.edaxh5`, `.oh5`, `.dream3d`, `.geoh5`, `.h5oina`, `.h5ad`.

For other extensions, right-click the file and select **Open With... > H5 Viewer (any extension)**.

To set H5 Viewer as default for additional extensions:

```json
"workbench.editorAssociations": {
  "*.foo": "h5viewer.viewer"
}
```

## Compression Plugins

Supported HDF5 compression filters: **Blosc**, **Blosc2**, **Bitshuffle**, **BZIP2**, **JPEG**, **LZ4**, **LZF**, **ZFP**, **Zstandard**.

Plugins are loaded automatically on the server side — no configuration needed.

## Platform Support

The extension is fully cross-platform. Both the HDF5 parser and compression plugins are compiled to WebAssembly, so a single package works on **x86_64** and **ARM64** (Linux, macOS, Windows).

## Architecture

```
Remote Server                          Local Machine
┌──────────────────────┐              ┌──────────────────────┐
│  Extension Host      │              │  Webview (Browser)   │
│  (Node.js)           │              │                      │
│                      │  postMessage │                      │
│  h5wasm ──> HDF5     │ <── request  │  DataProvider        │
│  (reads disk         │ ──> response │    getEntity()       │
│   directly)          │  (data slice)│    getValue()        │
│                      │              │                      │
│  Compression plugins │              │  @h5web/app renders  │
│  loaded locally      │              │  visualizations      │
└──────────────────────┘              └──────────────────────┘
```

## Credits

Built on top of [H5Web](https://h5web.panosc.eu/) and [h5wasm](https://github.com/usnistgov/h5wasm) by ESRF (European Synchrotron Radiation Facility).

## License

MIT

# H5 Viewer

[![GitHub](https://img.shields.io/github/license/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/blob/main/LICENSE.md)
[![GitHub Release](https://img.shields.io/github/v/release/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/releases)

**Visualize HDF5 files directly in VS Code** — optimized for Remote SSH with on-demand data loading.

[Chinese / 中文文档](./README.zh-CN.md)

![Demo](./assets/vscode-h5web.gif)

## Key Features

- **Line plots** — 1D datasets with error bars, auxiliary signals, and CSV export
- **Heatmaps** — 2D datasets with multiple colormaps, complex number support, and axis controls
- **Tables** — Matrix view for numerical and compound datasets
- **RGB images** — Direct visualization of RGB datasets
- **3D slicing** — Navigate slices of 3D+ datasets interactively
- **Audio playback** — Play audio data stored in HDF5/MAT files with waveform and spectrogram visualization
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

## MATLAB .mat File Support (Experimental)

> **Note:** MAT file support is experimental and has not been thoroughly tested. If you encounter issues, please [report them](https://github.com/NieeiM/H5-Viewer/issues).

| MAT Version | Support | Notes |
|---|---|---|
| **v7.3** | Full (on-demand loading) | HDF5-based, same fast experience as .h5 files |
| **v5 / v7** | Full (loads entire file) | Legacy binary format, parsed with mat-for-js |
| **v4** | Not supported | Prompt to resave as v7.3 |

For MAT v5/v7 files, a banner reminds you that the entire file is loaded into memory. For large files, resave in MATLAB with `save('file.mat', '-v7.3')` for better performance.

## EEG .cnt File Support (Experimental)

> **Note:** CNT file support is experimental and has not been thoroughly tested. If you encounter issues, please [report them](https://github.com/NieeiM/H5-Viewer/issues).

| Format | Support | Notes |
|---|---|---|
| **Neuroscan CNT** | Full (on-demand loading) | Binary format from SCAN/SynAmps/NuAmps systems. Random access, no file size limit |
| **ANT Neuro CNT** | Full (epoch-based loading) | RIFF container with RAW3 compression from eego/waveguard systems. Decompressed per-epoch |

Format is auto-detected from the file header. Each EEG channel is exposed as a 1D dataset (physical values in µV). Events/triggers are listed under `/events`.

## Supported File Extensions

The viewer opens automatically for: `.h5`, `.hdf`, `.hdf5`, `.hf5`, `.mat`, `.cnt`, `.nx`, `.nxs`, `.nx5`, `.nexus`, `.cxi`, `.nc`, `.nc4`, `.loom`, `.jld2`, `.h5ebsd`, `.edaxh5`, `.oh5`, `.dream3d`, `.geoh5`, `.h5oina`, `.h5ad`.

For other extensions, right-click the file and select **Open With... > H5 Viewer (any extension)**.

To set H5 Viewer as default for additional extensions:

```json
"workbench.editorAssociations": {
  "*.foo": "h5viewer.viewer"
}
```

## Audio Data Support (Experimental)

> **Note:** Audio support is experimental and has not been thoroughly tested. If you encounter issues, please [report them](https://github.com/NieeiM/H5-Viewer/issues).

The viewer automatically detects audio data inside HDF5/MAT files and shows a collapsible Audio Player panel at the bottom:

**Encoded audio blobs** — Datasets named with audio extensions (`.mp3`, `.wav`, `.flac`, `.ogg`, `.aac`, `.m4a`, `.opus`). Content is decoded using the browser's `AudioContext.decodeAudioData()`.

**PCM sample arrays** — 1D or 2D numeric datasets that look like raw audio (e.g. shape `[160000]` or `[2, 160000]`). Sample rate is read from attributes (`sample_rate`, `sampleRate`, etc.) or defaults to 44100 Hz.

Features: playback controls (play/pause, seek, volume), waveform visualization (Canvas 2D), and spectrogram visualization (FFT via ooura library). Large datasets trigger a warning before loading.

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

## Installation

**From GitHub Release:**

1. Go to [Releases](https://github.com/NieeiM/H5-Viewer/releases)
2. Download the `.vsix` file
3. In VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

**From source:**

```bash
git clone https://github.com/NieeiM/H5-Viewer.git
cd H5-Viewer
pnpm install
pnpm build
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
```

## Credits

Built on top of:
- [H5Web](https://h5web.panosc.eu/) and [h5wasm](https://github.com/usnistgov/h5wasm) by ESRF (European Synchrotron Radiation Facility)
- Audio playback and spectrum visualization adapted from [vscode-audio-preview](https://github.com/sukumo28/vscode-audio-preview) by sukumo28 (MIT License)
- ANT Neuro CNT RAW3 decompression ported from [libeep](https://github.com/mscheltienne/antio) (LGPL-3.0)

## License

GPL-3.0 (due to mat-for-js dependency)

# H5 Viewer

[![GitHub](https://img.shields.io/github/license/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/blob/main/LICENSE.md)
[![GitHub Release](https://img.shields.io/github/v/release/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/releases)

**Visualize scientific data, ML model weights, audio, and more — right inside VS Code.**

Optimized for Remote SSH. No file transfer, no size limit.

[Chinese / 中文文档](./README.zh-CN.md)

## Supported Formats

| Format | Extensions | How it works |
|---|---|---|
| **HDF5** | `.h5` `.hdf5` `.hdf` `.nx` `.nxs` `.nc` `.nc4` + [20 more](#all-extensions) | On-demand loading via h5wasm. Runs on the server, only requested data slices are transferred |
| **MATLAB** | `.mat` | v7.3 (HDF5-based): on-demand. v5/v7: full parse via mat-for-js |
| **NumPy** | `.npy` | Standalone files or blobs inside HDF5. Parsed transparently — shows real shape/dtype |
| **SafeTensors** | `.safetensors` | HuggingFace model format. On-demand tensor loading, even for multi-GB files |
| **GGUF** | `.gguf` | llama.cpp model format. Metadata + tensor tree. Non-quantized tensors visualizable |
| **PyTorch** | `.pt` `.pth` `.bin` `.pkl` | Checkpoint files (ZIP + pickle). Tensor weights, optimizer state, scalars |
| **EEG (Neuroscan)** | `.cnt` | Binary format. Random-access channel loading |
| **EEG (ANT Neuro)** | `.cnt` | RIFF/RAW3 compressed. Epoch-based decompression |
| **Audio blobs** | inside HDF5/MAT | `.wav` `.mp3` `.flac` `.ogg` `.aac` named datasets auto-detected |
| **JSON blobs** | inside HDF5/MAT | `.json` named datasets shown with syntax highlighting |

Format is auto-detected from file header (magic bytes), not just extension.

## Visualizations

- **Line plots** — 1D datasets with error bars, auxiliary signals, CSV export
- **Heatmaps** — 2D datasets with colormaps, complex number support, axis controls
- **Tables** — Matrix view for numerical and compound datasets
- **3D slicing** — Navigate slices of higher-dimensional datasets
- **Audio player** — Waveform + spectrogram (Linear/Log/Mel), playback with seek/volume/filters
- **JSON viewer** — Syntax-highlighted, auto-formatted, with copy and word wrap
- **ML model browser** — Hierarchical tensor tree from dot-separated names (e.g. `model.layers.0.weight`)

## Remote SSH Optimization

The original [vscode-h5web](https://github.com/silx-kit/vscode-h5web) transfers the entire file to the local browser for parsing. A 500 MB file = 500 MB network transfer. Files over 2 GB can't open at all.

**H5 Viewer runs the parser on the remote server** and sends only the data you're looking at:

| | Original H5Web | H5 Viewer |
|---|---|---|
| Open a 500 MB file | Transfer 500 MB | Transfer ~10 KB metadata |
| File size limit | 2 GB | **None** |
| Switching datasets | Instant (in memory) | RPC request (~ms) |

## Installation

**From GitHub Release:**
1. Go to [Releases](https://github.com/NieeiM/H5-Viewer/releases)
2. Download the `.vsix` file
3. `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

**From source:**
```bash
git clone https://github.com/NieeiM/H5-Viewer.git
cd H5-Viewer
pnpm install && pnpm build
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
```

## All Extensions

Default viewer for: `.h5`, `.hdf`, `.hdf5`, `.hf5`, `.mat`, `.cnt`, `.npy`, `.safetensors`, `.gguf`, `.pt`, `.pth`, `.bin`, `.pkl`, `.nx`, `.nxs`, `.nx5`, `.nexus`, `.cxi`, `.nc`, `.nc4`, `.loom`, `.jld2`, `.h5ebsd`, `.edaxh5`, `.oh5`, `.dream3d`, `.geoh5`, `.h5oina`, `.h5ad`.

For other files: right-click → **Open With... → H5 Viewer (any extension)**.

```json
"workbench.editorAssociations": {
  "*.foo": "h5viewer.viewer"
}
```

## Experimental Features

The following are functional but not thoroughly tested:

- **MATLAB .mat** (v5/v7/v7.3)
- **EEG .cnt** (Neuroscan + ANT Neuro)
- **Audio** playback and spectrogram
- **SafeTensors**, **GGUF**, and **PyTorch** (.pt/.pth/.bin/.pkl) model files
- **NPY** and **JSON** embedded datasets

[Report issues](https://github.com/NieeiM/H5-Viewer/issues)

## Platform Support

Single package works on **x86_64** and **ARM64** (Linux, macOS, Windows). All parsers are WebAssembly or pure JavaScript — no native binaries.

## Credits

Built on:
- [H5Web](https://h5web.panosc.eu/) and [h5wasm](https://github.com/usnistgov/h5wasm) by ESRF
- Audio visualization adapted from [vscode-audio-preview](https://github.com/sukumo28/vscode-audio-preview) by sukumo28 (MIT)
- ANT Neuro CNT RAW3 decompression ported from [libeep](https://github.com/mscheltienne/antio) (LGPL-3.0)

## License

GPL-3.0

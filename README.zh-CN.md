# H5 Viewer

[![GitHub](https://img.shields.io/github/license/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/blob/main/LICENSE.md)
[![GitHub Release](https://img.shields.io/github/v/release/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/releases)

**在 VS Code 中可视化科学数据、ML 模型权重、音频等各类数据文件。**

专为 Remote SSH 优化，无需文件传输，无大小限制。

[English / 英文文档](./README.md)

## 支持的格式

| 格式 | 扩展名 | 工作方式 |
|---|---|---|
| **HDF5** | `.h5` `.hdf5` `.hdf` `.nx` `.nxs` `.nc` `.nc4` + [更多](#全部扩展名) | 通过 h5wasm 按需加载。解析在服务器端运行，仅传输请求的数据切片 |
| **MATLAB** | `.mat` | v7.3（HDF5）：按需加载。v5/v7：全量解析 |
| **NumPy** | `.npy` | 独立文件或 HDF5 内嵌 blob。透明解析，显示真实的形状和数据类型 |
| **SafeTensors** | `.safetensors` | HuggingFace 模型格式。按需加载 tensor，支持多 GB 文件 |
| **GGUF** | `.gguf` | llama.cpp 模型格式。元数据 + tensor 树。非量化 tensor 可可视化 |
| **PyTorch** | `.pt` `.pth` `.bin` `.pkl` | Checkpoint 文件（ZIP + pickle）。Tensor 权重、优化器状态、标量 |
| **脑电 (Neuroscan)** | `.cnt` | 二进制格式。随机访问通道加载 |
| **脑电 (ANT Neuro)** | `.cnt` | RIFF/RAW3 压缩格式。按 epoch 解压 |
| **音频 blob** | HDF5/MAT 内嵌 | `.wav` `.mp3` `.flac` `.ogg` `.aac` 命名的 dataset 自动检测 |
| **JSON blob** | HDF5/MAT 内嵌 | `.json` 命名的 dataset 语法高亮展示 |

格式通过文件头 magic bytes 自动检测，不仅仅依赖扩展名。

## 可视化类型

- **折线图** — 1D 数据集，支持误差棒、辅助信号、CSV 导出
- **热力图** — 2D 数据集，多种 colormap、复数支持、轴控制
- **表格** — 数值和复合数据集的矩阵视图
- **3D 切片** — 交互式浏览高维数据集切片
- **音频播放器** — 波形 + 频谱图（Linear/Log/Mel），支持播放/定位/音量/滤波器
- **JSON 查看器** — 语法高亮、自动格式化、复制、自动换行
- **ML 模型浏览** — 从点分隔名称构建层级化 tensor 树（如 `model.layers.0.weight`）

## 远程 SSH 优化

原版 [vscode-h5web](https://github.com/silx-kit/vscode-h5web) 将整个文件传输到本地浏览器解析。500 MB 文件 = 500 MB 网络传输。超过 2 GB 的文件无法打开。

**H5 Viewer 在远程服务器上运行解析器**，仅发送你正在查看的数据：

| | 原版 H5Web | H5 Viewer |
|---|---|---|
| 打开 500 MB 文件 | 传输 500 MB | 传输约 10 KB 元数据 |
| 文件大小限制 | 2 GB | **无限制** |
| 切换数据集 | 即时（内存中） | RPC 请求（毫秒级） |

## 安装

**从 GitHub Release 安装：**
1. 前往 [Releases](https://github.com/NieeiM/H5-Viewer/releases)
2. 下载 `.vsix` 文件
3. `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

**从源码构建：**
```bash
git clone https://github.com/NieeiM/H5-Viewer.git
cd H5-Viewer
pnpm install && pnpm build
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
```

## 全部扩展名

默认打开：`.h5`、`.hdf`、`.hdf5`、`.hf5`、`.mat`、`.cnt`、`.npy`、`.safetensors`、`.gguf`、`.nx`、`.nxs`、`.nx5`、`.nexus`、`.cxi`、`.nc`、`.nc4`、`.loom`、`.jld2`、`.h5ebsd`、`.edaxh5`、`.oh5`、`.dream3d`、`.geoh5`、`.h5oina`、`.h5ad`。

其他文件：右键 → **打开方式... → H5 Viewer (any extension)**。

```json
"workbench.editorAssociations": {
  "*.foo": "h5viewer.viewer"
}
```

## 实验性功能

以下功能可用但尚未充分测试：

- **MATLAB .mat**（v5/v7/v7.3）
- **脑电 .cnt**（Neuroscan + ANT Neuro）
- **音频**播放和频谱图
- **SafeTensors** 和 **GGUF** 模型文件
- **NPY** 和 **JSON** 内嵌数据集

[反馈问题](https://github.com/NieeiM/H5-Viewer/issues)

## 平台支持

单个安装包兼容 **x86_64** 和 **ARM64**（Linux、macOS、Windows）。所有解析器基于 WebAssembly 或纯 JavaScript，无原生二进制依赖。

## 致谢

基于以下项目构建：
- [H5Web](https://h5web.panosc.eu/) 和 [h5wasm](https://github.com/usnistgov/h5wasm)，由 ESRF 开发
- 音频播放和频谱可视化改编自 [vscode-audio-preview](https://github.com/sukumo28/vscode-audio-preview)，由 sukumo28 开发（MIT）
- ANT Neuro CNT RAW3 解压缩移植自 [libeep](https://github.com/mscheltienne/antio)（LGPL-3.0）

## 许可证

GPL-3.0

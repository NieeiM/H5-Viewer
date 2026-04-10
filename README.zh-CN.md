# H5 Viewer

[![GitHub](https://img.shields.io/github/license/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/blob/main/LICENSE.md)
[![GitHub Release](https://img.shields.io/github/v/release/NieeiM/H5-Viewer)](https://github.com/NieeiM/H5-Viewer/releases)

**在 VS Code 中直接可视化 HDF5 文件** — 专为 Remote SSH 远程开发优化，按需加载数据。

[English / 英文文档](./README.md)

![演示](./assets/vscode-h5web.gif)

## 核心功能

- **折线图** — 1D 数据集，支持误差棒、辅助信号、CSV 导出
- **热力图** — 2D 数据集，多种 colormap、复数支持、轴控制
- **表格视图** — 数值矩阵和复合数据集的表格展示
- **RGB 图像** — 直接可视化 RGB 数据集
- **3D 切片浏览** — 交互式浏览 3D 及更高维数据集的切片
- **音频播放** — 播放 HDF5/MAT 文件中存储的音频数据，带波形和频谱可视化
- **NeXus 支持** — 自动解释 NXdata 组和轴数据集
- **元数据检查器** — 查看属性、chunk 布局、压缩过滤器、数据类型
- **搜索** — 在整个文件树中搜索实体

## 远程优化

本插件是 [vscode-h5web](https://github.com/silx-kit/vscode-h5web) 的 fork，重新设计了架构以优化远程开发体验。

### 原版的问题

原版插件在远程场景下会将**整个 HDF5 文件**从服务器传输到本地浏览器进行解析。一个 500 MB 的文件意味着需要传输 500 MB 才能开始渲染。超过 2 GB 的文件根本无法打开。

### 解决方案

H5 Viewer 将 HDF5 解析器 (h5wasm) 运行在**远程服务器**（Extension Host）上，仅通过 VS Code 的消息通道将需要的数据切片发送到本地 webview。文件始终留在服务器上。

| | 原版 | H5 Viewer |
|---|---|---|
| 打开 500 MB 文件 | 传输 500 MB 后解析 | 服务器端解析，传输约 10 KB 元数据 |
| 切换数据集 | 即时（内存中） | RPC 请求（毫秒级延迟） |
| 文件大小限制 | 2 GB | **无限制** |
| 远程体验 | 慢 | 快 |

## MATLAB .mat 文件支持（实验性）

> **注意：** MAT 文件支持为实验性功能，尚未经过充分测试。如遇到问题，请[提交 Issue](https://github.com/NieeiM/H5-Viewer/issues)。

| MAT 版本 | 支持情况 | 说明 |
|---|---|---|
| **v7.3** | 完整支持（按需加载） | 基于 HDF5，与 .h5 文件体验一致 |
| **v5 / v7** | 完整支持（全量加载） | 传统二进制格式，使用 mat-for-js 解析 |
| **v4** | 不支持 | 提示用户用 v7.3 格式重新保存 |

对于 MAT v5/v7 文件，界面顶部会显示提示横幅，说明文件已全量加载到内存。对于大文件，建议在 MATLAB 中用 `save('file.mat', '-v7.3')` 重新保存以获得更好的性能。

## 脑电 .cnt 文件支持（实验性）

> **注意：** CNT 文件支持为实验性功能，尚未经过充分测试。如遇到问题，请[提交 Issue](https://github.com/NieeiM/H5-Viewer/issues)。

| 格式 | 支持情况 | 说明 |
|---|---|---|
| **Neuroscan CNT** | 完整支持（按需加载） | SCAN/SynAmps/NuAmps 系统的二进制格式。随机访问，无文件大小限制 |
| **ANT Neuro CNT** | 完整支持（按 epoch 加载） | eego/waveguard 系统的 RIFF 容器 + RAW3 压缩格式。按 epoch 解压 |

格式从文件头自动检测。每个 EEG 通道作为 1D 数据集展示（物理值，单位 µV）。事件/触发器列在 `/events` 下。

## 支持的文件扩展名

自动打开以下格式：`.h5`、`.hdf`、`.hdf5`、`.hf5`、`.mat`、`.cnt`、`.nx`、`.nxs`、`.nx5`、`.nexus`、`.cxi`、`.nc`、`.nc4`、`.loom`、`.jld2`、`.h5ebsd`、`.edaxh5`、`.oh5`、`.dream3d`、`.geoh5`、`.h5oina`、`.h5ad`。

其他扩展名可右键文件选择 **打开方式... > H5 Viewer (any extension)**。

将 H5 Viewer 设为其他扩展名的默认编辑器：

```json
"workbench.editorAssociations": {
  "*.foo": "h5viewer.viewer"
}
```

## 音频数据支持（实验性）

> **注意：** 音频支持为实验性功能，尚未经过充分测试。如遇到问题，请[提交 Issue](https://github.com/NieeiM/H5-Viewer/issues)。

插件自动检测 HDF5/MAT 文件中的音频数据，并在底部显示可折叠的音频播放面板：

**编码音频 blob** — 以音频扩展名（`.mp3`、`.wav`、`.flac`、`.ogg`、`.aac`、`.m4a`、`.opus`）命名的 dataset。使用浏览器 `AudioContext.decodeAudioData()` 解码。

**PCM 采样数组** — 看起来像音频的 1D 或 2D 数值 dataset（如 shape `[160000]` 或 `[2, 160000]`）。采样率从属性中读取（`sample_rate`、`sampleRate` 等），默认 44100 Hz。

功能：播放控制（播放/暂停、拖动、音量）、波形可视化（Canvas 2D）、频谱图可视化（FFT，使用 ooura 库）。大数据集加载前会显示警告。

## NumPy .npy 支持（实验性）

> **注意：** NPY 支持为实验性功能。如遇到问题，请[提交 Issue](https://github.com/NieeiM/H5-Viewer/issues)。

以 `.npy` 扩展名命名的 dataset 会被自动识别为嵌入的 NumPy 数组。插件透明解析 NPY 二进制格式（v1.0/v2.0/v3.0），展示实际的数组形状、数据类型和值，而非原始字节。支持所有标准 NumPy 数据类型（int8-64、uint8-64、float16-64、bool）。解析后的数组使用标准的折线图/热力图/表格可视化展示。

## JSON 查看器（实验性）

> **注意：** JSON 支持为实验性功能。如遇到问题，请[提交 Issue](https://github.com/NieeiM/H5-Viewer/issues)。

以 `.json` 扩展名命名的 dataset 在可折叠的 JSON 查看面板中展示，具有语法高亮、自动格式化（将紧凑 JSON 转为缩进格式）、自动换行开关和一键复制功能。

## 压缩插件

支持的 HDF5 压缩过滤器：**Blosc**、**Blosc2**、**Bitshuffle**、**BZIP2**、**JPEG**、**LZ4**、**LZF**、**ZFP**、**Zstandard**。

插件在服务器端自动加载，无需额外配置。

## 平台支持

本插件完全跨平台。HDF5 解析器和压缩插件均编译为 WebAssembly，单个安装包同时兼容 **x86_64** 和 **ARM64**（Linux、macOS、Windows）。

## 架构

```
远程服务器                                本地机器
┌──────────────────────┐              ┌──────────────────────┐
│  Extension Host      │              │  Webview (浏览器)     │
│  (Node.js)           │              │                      │
│                      │  postMessage │                      │
│  h5wasm ──> HDF5文件  │ <── 请求     │  DataProvider        │
│  (直接读取磁盘,       │ ──> 响应     │    getEntity()       │
│   无需加载到内存)      │  (数据切片)  │    getValue()        │
│                      │              │                      │
│  压缩插件在本地加载    │              │  @h5web/app 渲染     │
│                      │              │  可视化组件            │
└──────────────────────┘              └──────────────────────┘
```

## 安装

**从 GitHub Release 安装：**

1. 前往 [Releases](https://github.com/NieeiM/H5-Viewer/releases)
2. 下载 `.vsix` 文件
3. 在 VS Code 中：`Ctrl+Shift+P` → `Extensions: Install from VSIX...`

**从源码构建：**

```bash
git clone https://github.com/NieeiM/H5-Viewer.git
cd H5-Viewer
pnpm install
pnpm build
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository
```

## 致谢

基于以下项目构建：
- [H5Web](https://h5web.panosc.eu/) 和 [h5wasm](https://github.com/usnistgov/h5wasm)，由 ESRF（欧洲同步辐射光源）开发
- 音频播放和频谱可视化改编自 [vscode-audio-preview](https://github.com/sukumo28/vscode-audio-preview)，由 sukumo28 开发（MIT 许可证）
- ANT Neuro CNT RAW3 解压缩移植自 [libeep](https://github.com/mscheltienne/antio)（LGPL-3.0）

## 许可证

GPL-3.0（因 mat-for-js 依赖）

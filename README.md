# monitor-player（v3：Tauri + 本地 FFmpeg RTSP）

桌面端基于 **Tauri 2**：Rust 调用本地 FFmpeg 拉取 RTSP（copy → fragmented MP4），经本机 WebSocket 转发，前端用 **MSE + `<video>`** 硬解播放。支持多窗口、连接池、一键截图、快捷键与 Windows 内存触发截图。

> 浏览器直接打开仅可浏览 UI，无法拉流；请使用桌面版。

## 运行

```bash
npm install
npm run download-ffmpeg
npm run tauri:dev
```

打包：

```bash
npm run tauri:build
```

## 许可说明

安装包内含 FFmpeg 静态二进制，商业分发请遵守对应 FFmpeg LGPL/GPL 条款。Windows 播放 H.265 可能需要安装系统 HEVC 视频扩展。

## 旧版说明

Electron / MediaMTX WHEP 路径已移除；历史设计见 `docs/DEVELOPMENT.md`。

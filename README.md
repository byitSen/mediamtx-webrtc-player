# MediaMTX WebRTC Player（v2：本地 FFmpeg RTSP）

桌面端（Electron）通过 **本地 FFmpeg** 拉取摄像头 RTSP（H.265 裸流），经本机 WebSocket 转发，再用 **WebCodecs** 硬解到 canvas 多窗口预览；支持统一时间戳一键截图、连接池与懒加载、Windows 内存触发截图等。

> v2 起默认不再依赖 MediaMTX / WHEP。浏览器直接打开页面时仅提示使用桌面版，不会启动 FFmpeg。

## 功能概览

- **本地 RTSP 代理播放**：FFmpeg `-vcodec copy -f hevc` → `ws://127.0.0.1` → WebCodecs → canvas。
- **多窗口 Grid**：可配置列数；可见区域才激活，失活销毁代理以控制 FFmpeg 进程数。
- **断连重连 / 手动重连**、应用内全屏（缩放拖拽）。
- **一键批量截图**（含快捷键、可选 Windows 内存触发）。
- **设置面板**：摄像头 `名称 + rtspUrl`、窗口尺寸、截图目录等。

## 运行

```bash
npm install
npm run download-ffmpeg   # 下载当前平台 FFmpeg 到 resources/ffmpeg/
npm run start             # Electron
```

开发热刷：

```bash
npm run download-ffmpeg
npm run dev               # http://localhost:8000
npm run start:dev         # Electron 加载上述地址
```

打包（`prebuild` 会自动 download-ffmpeg）：

```bash
npm run build
```

## 许可说明

安装包内含 FFmpeg 静态二进制，商业分发请遵守对应 FFmpeg LGPL/GPL 许可条款。

## 参考

- WebCodecs `VideoDecoder`、HEVC 系统硬解（Windows 可能需安装 HEVC 视频扩展）。
- 旧版 MediaMTX/WHEP 设计见 `docs/DEVELOPMENT.md`（已非默认路径）。

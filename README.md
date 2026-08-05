# monitor-player（v4：Tauri + go2rtc + WebRTC）

桌面端基于 **Tauri 2**：内嵌 **go2rtc** 拉取摄像头 RTSP，前端经 **WebSocket 信令 + WebRTC** 绑定到 `<video>` 播放（对齐官方 [VideoRTC.onwebrtc](https://github.com/AlexxIT/go2rtc/blob/master/www/video-rtc.js)）。支持多窗口、连接配额、一键截图、快捷键与 Windows 内存触发截图。

> 浏览器直接打开仅可浏览 UI，无法拉流；请使用桌面版。

## 播放链路

```
摄像头 RTSP
  → go2rtc（本机 127.0.0.1:1984）动态注册流
  → WS /api/ws?src=<name>（webrtc/offer|answer|candidate）
  → RTCPeerConnection → <video>.srcObject
```

## 运行

```bash
npm install
npm run download-go2rtc
npm run tauri:dev
```

打包：

```bash
npm run tauri:build
```

## 兼容说明

- 设置中仍填写摄像头 **RTSP 地址**；应用自动注册到 go2rtc。
- **H.264** WebRTC 兼容性最好；**H.265** 依赖 WebView/系统编解码支持（Chrome 136+ / Safari 18+ 等）。
- 安装包内含 go2rtc 二进制，请遵守其开源许可证。

## 旧版说明

MSE / WHEP / Electron / MediaMTX 路径已从主播放链路移除；`js/go2rtc-mse-player.js` 仍保留作参考。历史设计见 `docs/DEVELOPMENT.md`。

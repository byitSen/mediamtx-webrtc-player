# MediaMTX + WebRTC 多窗口摄像头播放器

本仓库用于构建一个 **基于 MediaMTX + WebRTC 的多窗口摄像头播放器**，支持多路 RTSP 摄像头的低延迟（目标 < 300ms）预览、统一时间戳一键截图、摄像头管理面板、性能监控、懒加载与连接池等高级特性。

> 说明：当前仓库主要提供架构与实现说明文档，核心代码可按文档逐步实现或从现有项目迁移/改造。

## 功能概览

- **多窗口播放**：Grid 布局并行展示多路摄像头，可自定义每行列数。
- **断连自动重连 + 手动重连**：内置连接状态机与重连策略。
- **应用内全屏**：双击单路视频卡片，在应用内全屏/退出全屏切换。
- **连接状态可视化**：每路卡片展示连接中/已连接/断开/未就绪等状态。
- **低延迟 WebRTC 播放**：通过 MediaMTX 提供的 WHEP 端点与浏览器 WebRTC API 实现。
- **纯前端运行**：静态站点，无需自建业务后端，仅依赖外部 MediaMTX。
- **一键批量截图 + 统一时间戳**：一次操作为所有在线摄像头截图，并使用统一时间戳生成逻辑路径 `父目录/YYYY-MM-DD/HH-MM-SS/摄像头名称_时间戳.png`。
- **摄像头管理面板**：通过表单动态增删摄像头配置，并持久化到浏览器存储。
- **性能监控**：基于 `RTCPeerConnection.getStats()` 展示每路流的延迟、帧率、丢包率等指标。
- **懒加载与连接池**：基于 `IntersectionObserver` 控制可视区域的连接创建/释放，并通过连接池限制最大活跃连接数，降低资源占用。

## 目录结构

```text
mediamtx-webrtc-player/
  README.md           # 当前文件
  docs/
    DEVELOPMENT.md    # 详细开发技术文档（架构、数据流、接口与 11 项核心特性说明）
  js/                 # 预留：前端 JS 模块目录
  css/                # 预留：样式文件目录
```

## 如何开始

1. **阅读开发技术文档**

   请首先阅读 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)，该文档详细说明了：

   - 整体系统架构与数据流（RTSP → MediaMTX → WebRTC/WHEP → 浏览器）。
   - 11 项核心特性的实现设计与约定（多窗口、重连、全屏、懒加载、连接池等）。
   - 推荐的前端模块划分与目录结构。
   - MediaMTX 与浏览器 WebRTC 的关键配置与实践建议。

2. **准备 MediaMTX 环境**

   - 按 MediaMTX 官方文档部署服务（本地或服务器）。
   - 配置 RTSP 摄像头为 MediaMTX 的 `paths`，并确认 WebRTC/WHEP 端点可用，例如：
     - `http://localhost:8889/cam1/whep`。
   - **H.265 源**：当前桌面端（Electron/Chromium）无法在 WebRTC 中直接播放 H.265，需在 MediaMTX 里用 FFmpeg 将 H.265 转成 H.264。请使用**转码后的路径**（如 `cam1`），不要用直连 H.265 的路径（如 `cam1_raw`）。参考根目录 `mediamtx.yml` 中的 `runOnDemand` 示例。
   - 项目根目录提供 MediaMTX 启动/停止脚本（需先将 MediaMTX 可执行文件加入 PATH 或放入项目根目录）：
     - **macOS/Linux**：`./mediamtx.sh start` 启动，`./mediamtx.sh stop` 停止（无执行权限时先执行 `chmod +x mediamtx.sh`）。
     - **Windows**：`mediamtx.bat start` 启动，`mediamtx.bat stop` 停止。

3. **实现前端页面（可选）**

   - 基于 `DEVELOPMENT.md` 中的设计，在本仓库中创建 `index.html` 与对应 JS/CSS 模块，实现多窗口播放器逻辑。
   - 或从既有的 `webrtc-camera-player` 项目中迁移代码，并按本仓库文档对其进行连接池、懒加载、性能监控等方面的扩展。

## 运行建议（示例）

### 桌面版（Electron，推荐）

- 安装依赖并启动（使用内置 Chromium，支持 H.265 等）：

  ```bash
  npm install
  npm run start
  ```

- 开发时先起静态服务再启动 Electron，可热刷前端：

  ```bash
  npm run dev          # 终端 1：http://localhost:8000
  npm run start:dev    # 终端 2：Electron 加载上述地址
  ```

- 打包安装包：

  ```bash
  npm run build        # 根据当前系统生成 win/mac 安装包到 release/
  npm run build:win    # 仅 Windows
  npm run build:mac    # 仅 macOS
  ```

### 纯浏览器

- 安装静态服务器（可选）：

  ```bash
  npm install --save-dev serve
  npx serve . -p 8000
  ```

- 在浏览器打开 `http://localhost:8000`，根据 UI 配置 MediaMTX 地址与摄像头列表后进行调试。

## 参考资料

- MediaMTX 官方仓库及文档（尤其是 WebRTC/WHEP 相关章节）。
- MDN WebRTC API 文档与示例。
- WebRTC `RTCPeerConnection.getStats()` 统计指标说明。


#!/usr/bin/env node
/**
 * 下载当前平台的静态 FFmpeg 到 resources/ffmpeg/{platform}/
 * 来源：eugeneware/ffmpeg-static（gzip 单二进制）
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { createGunzip } = require("zlib");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");

const VERSION = "b6.1.1";
const ROOT = path.join(__dirname, "..");
const platform = process.platform;
const arch = process.arch === "arm64" ? "arm64" : "x64";

/** electron-builder ${os}：win | mac | linux */
function builderOsDir() {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  return null;
}

const osDir = builderOsDir();
if (!osDir) {
  console.error(`[download-ffmpeg] 不支持的平台: ${platform}`);
  process.exit(1);
}

const outDir = path.join(ROOT, "resources", "ffmpeg", osDir);
const binaryName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const outFile = path.join(outDir, binaryName);
// b6+ 资源名形如 ffmpeg-darwin-arm64.gz / ffmpeg-win32-x64.gz
const assetArch = platform === "win32" ? "x64" : arch;
const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${VERSION}/ffmpeg-${platform}-${assetArch}.gz`;

function followRedirect(targetUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      reject(new Error("too many redirects"));
      return;
    }
    const lib = targetUrl.startsWith("https") ? https : http;
    lib
      .get(targetUrl, { headers: { "User-Agent": "mediamtx-webrtc-player" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          followRedirect(res.headers.location, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100000) {
    console.log(`[download-ffmpeg] 已存在，跳过: ${outFile}`);
    return;
  }

  console.log(`[download-ffmpeg] 下载 ${url}`);
  const res = await followRedirect(url);
  const tmp = `${outFile}.tmp`;
  await pipeline(res, createGunzip(), createWriteStream(tmp));
  fs.renameSync(tmp, outFile);
  if (platform !== "win32") {
    fs.chmodSync(outFile, 0o755);
  }
  console.log(`[download-ffmpeg] 完成: ${outFile} (${fs.statSync(outFile).size} bytes)`);
}

main().catch((err) => {
  console.error("[download-ffmpeg] 失败:", err.message || err);
  process.exit(1);
});

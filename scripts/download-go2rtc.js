#!/usr/bin/env node
/**
 * 下载当前平台 go2rtc 到 src-tauri/resources/go2rtc/
 * 来源：AlexxIT/go2rtc GitHub Releases
 */
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const VERSION = "v1.9.14";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const platform = process.platform;
const arch = process.arch === "arm64" ? "arm64" : "x64";

if (!["win32", "darwin", "linux"].includes(platform)) {
  console.error(`[download-go2rtc] 不支持的平台: ${platform}`);
  process.exit(1);
}

const outDir = path.join(ROOT, "src-tauri", "resources", "go2rtc");
const binaryName = platform === "win32" ? "go2rtc.exe" : "go2rtc";
const outFile = path.join(outDir, binaryName);

function assetName() {
  if (platform === "win32") {
    if (process.arch === "arm64") return "go2rtc_win_arm64.zip";
    return "go2rtc_win64.zip";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "go2rtc_mac_arm64.zip" : "go2rtc_mac_amd64.zip";
  }
  // linux：官方为裸二进制（非 zip）
  return arch === "arm64" ? "go2rtc_linux_arm64" : "go2rtc_linux_amd64";
}

const url = `https://github.com/AlexxIT/go2rtc/releases/download/${VERSION}/${assetName()}`;

function followRedirect(targetUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      reject(new Error("too many redirects"));
      return;
    }
    const lib = targetUrl.startsWith("https") ? https : http;
    lib
      .get(targetUrl, { headers: { "User-Agent": "monitor-player" } }, (res) => {
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

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (platform === "win32") {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`],
      { stdio: "inherit" }
    );
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "inherit" });
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ["go2rtc", "go2rtc.exe"]) {
    const p = path.join(outDir, name);
    if (name !== binaryName && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
  }
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 500000) {
    console.log(`[download-go2rtc] 已存在，跳过: ${outFile}`);
    return;
  }

  console.log(`[download-go2rtc] 下载 ${url}`);
  const res = await followRedirect(url);
  const asset = assetName();
  const isZip = asset.endsWith(".zip");
  const tmpDownload = path.join(tmpdir(), `go2rtc-dl-${process.pid}${isZip ? ".zip" : ".bin"}`);

  await pipeline(res, createWriteStream(tmpDownload));

  if (isZip) {
    const extractDir = path.join(tmpdir(), `go2rtc-extract-${process.pid}`);
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      extractZip(tmpDownload, extractDir);
      const candidates = [];
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (ent.name === binaryName || ent.name === "go2rtc" || ent.name === "go2rtc.exe") {
            candidates.push(p);
          }
        }
      };
      walk(extractDir);
      const src =
        candidates.find((p) => path.basename(p) === binaryName) ||
        candidates[0];
      if (!src) throw new Error("zip 内未找到 go2rtc 二进制");
      fs.copyFileSync(src, outFile);
    } finally {
      try {
        fs.rmSync(extractDir, { recursive: true, force: true });
      } catch (_) {}
      try {
        fs.unlinkSync(tmpDownload);
      } catch (_) {}
    }
  } else {
    fs.renameSync(tmpDownload, outFile);
  }

  if (platform !== "win32") {
    fs.chmodSync(outFile, 0o755);
  }
  console.log(`[download-go2rtc] 完成: ${outFile} (${fs.statSync(outFile).size} bytes)`);
}

main().catch((err) => {
  console.error("[download-go2rtc] 失败:", err.message || err);
  process.exit(1);
});

//! RTSP → FFmpeg (copy → fragmented MP4) → local WebSocket proxy

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

const START_PORT: u16 = 19000;
const MAX_PROXIES: usize = 16;

pub struct ProxyHandle {
    pub port: u16,
    pub ws_url: String,
    shutdown: Option<oneshot::Sender<()>>,
}

pub struct RtspProxyManager {
    proxies: Mutex<HashMap<String, ProxyHandle>>,
    next_port: AtomicU16,
    app: AppHandle,
}

impl RtspProxyManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            proxies: Mutex::new(HashMap::new()),
            next_port: AtomicU16::new(START_PORT),
            app,
        }
    }

    pub async fn start_proxy(self: &Arc<Self>, rtsp_url: String) -> Result<String> {
        let url = rtsp_url.trim().to_string();
        if url.is_empty() {
            return Err(anyhow!("rtspUrl 为空"));
        }
        if !(url.starts_with("rtsp://") || url.starts_with("rtsps://")) {
            return Err(anyhow!("无效的 RTSP 地址"));
        }

        let ffmpeg_path = resolve_ffmpeg_path(&self.app)?;

        // 同 URL：已就绪则复用；启动中则等待
        for _ in 0..200 {
            let status = {
                let map = self.proxies.lock();
                match map.get(&url) {
                    Some(h) if h.shutdown.is_some() => Some(Some(h.ws_url.clone())),
                    Some(_) => Some(None), // 占位中
                    None => None,
                }
            };
            match status {
                Some(Some(ws)) => return Ok(ws),
                Some(None) => {
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                    continue;
                }
                None => break,
            }
        }

        let port;
        let ws_url;
        let shutdown_tx;
        let shutdown_rx;
        let ready_tx;
        let ready_rx;
        {
            let mut map = self.proxies.lock();
            if let Some(h) = map.get(&url) {
                // 等待期间别人已建好
                if h.shutdown.is_some() {
                    return Ok(h.ws_url.clone());
                }
                return Err(anyhow!("代理启动超时或冲突，请重试"));
            }
            if map.len() >= MAX_PROXIES {
                return Err(anyhow!("超出最大并发路数限制: {}", MAX_PROXIES));
            }
            port = Self::alloc_port_locked(&map, &self.next_port);
            ws_url = format!("ws://127.0.0.1:{}", port);
            let (tx, rx) = oneshot::channel::<()>();
            let (rtx, rrx) = oneshot::channel::<Result<()>>();
            shutdown_tx = tx;
            shutdown_rx = rx;
            ready_tx = rtx;
            ready_rx = rrx;
            map.insert(
                url.clone(),
                ProxyHandle {
                    port,
                    ws_url: ws_url.clone(),
                    shutdown: None,
                },
            );
        }

        let rtsp = url.clone();
        let mgr = Arc::clone(self);
        tokio::spawn(async move {
            let result =
                run_proxy_loop(rtsp.clone(), port, ffmpeg_path, shutdown_rx, ready_tx).await;
            if let Err(e) = &result {
                eprintln!("[rtsp-proxy] port {} error: {:#}", port, e);
            }
            mgr.proxies.lock().remove(&rtsp);
        });

        match ready_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                self.proxies.lock().remove(&url);
                return Err(e);
            }
            Err(_) => {
                self.proxies.lock().remove(&url);
                return Err(anyhow!("代理启动失败（ready channel closed）"));
            }
        }

        if let Some(h) = self.proxies.lock().get_mut(&url) {
            h.shutdown = Some(shutdown_tx);
        } else {
            let _ = shutdown_tx.send(());
            return Err(anyhow!("代理在就绪前已被移除"));
        }
        Ok(ws_url)
    }

    pub fn stop_proxy(&self, rtsp_url: &str) {
        let url = rtsp_url.trim();
        if let Some(mut h) = self.proxies.lock().remove(url) {
            if let Some(tx) = h.shutdown.take() {
                let _ = tx.send(());
            }
        }
    }

    pub fn stop_all(&self) {
        let mut map = self.proxies.lock();
        for (_, mut h) in map.drain() {
            if let Some(tx) = h.shutdown.take() {
                let _ = tx.send(());
            }
        }
    }

    fn alloc_port_locked(map: &HashMap<String, ProxyHandle>, next_port: &AtomicU16) -> u16 {
        let used: Vec<u16> = map.values().map(|p| p.port).collect();
        let mut port = next_port.load(Ordering::Relaxed);
        for _ in 0..1000 {
            if !used.contains(&port) {
                let next = if port == u16::MAX {
                    START_PORT
                } else {
                    port + 1
                };
                next_port.store(next.max(START_PORT), Ordering::Relaxed);
                return port;
            }
            port = if port == u16::MAX {
                START_PORT
            } else {
                port + 1
            };
        }
        START_PORT
    }
}

pub fn resolve_ffmpeg_path(app: &AppHandle) -> Result<PathBuf> {
    let binary = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    if let Ok(dir) = app.path().resource_dir() {
        let candidates = [
            dir.join("resources").join("ffmpeg").join(binary),
            dir.join("ffmpeg").join(binary),
            dir.join(binary),
        ];
        for c in candidates {
            if c.is_file() {
                return Ok(c);
            }
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("ffmpeg")
        .join(binary);
    if dev.is_file() {
        return Ok(dev);
    }

    Err(anyhow!(
        "未找到 FFmpeg（请先运行 npm run download-ffmpeg）: {}",
        dev.display()
    ))
}

async fn run_proxy_loop(
    rtsp_url: String,
    port: u16,
    ffmpeg_path: PathBuf,
    mut shutdown_rx: oneshot::Receiver<()>,
    ready_tx: oneshot::Sender<Result<()>>,
) -> Result<()> {
    let addr = format!("127.0.0.1:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            let _ = ready_tx.send(Ok(()));
            l
        }
        Err(e) => {
            let err = anyhow!("bind {}: {}", addr, e);
            let _ = ready_tx.send(Err(anyhow!("{}", err)));
            return Err(err);
        }
    };

    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                kill_child(&child_slot).await;
                break;
            }
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[rtsp-proxy] accept error: {}", e);
                        break;
                    }
                };
                kill_child(&child_slot).await;

                let ws = match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(e) => {
                        eprintln!("[rtsp-proxy] ws accept: {}", e);
                        continue;
                    }
                };
                let (mut sink, mut source) = ws.split();

                // 同一 WS 会话内 FFmpeg 挂了就自动重启，避免前端只剩最后一帧
                let mut client_gone = false;
                while !client_gone {
                    let mut child = match spawn_ffmpeg(&ffmpeg_path, &rtsp_url) {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[rtsp-proxy] ffmpeg spawn: {:#}", e);
                            break;
                        }
                    };
                    let mut stdout = match child.stdout.take() {
                        Some(s) => s,
                        None => {
                            let _ = child.kill().await;
                            break;
                        }
                    };
                    *child_slot.lock() = Some(child);

                    let slot = child_slot.clone();
                    let pump = async {
                        let mut buf = vec![0u8; 32768];
                        loop {
                            match stdout.read(&mut buf).await {
                                Ok(0) => break,
                                Ok(n) => {
                                    if sink
                                        .send(Message::Binary(buf[..n].to_vec().into()))
                                        .await
                                        .is_err()
                                    {
                                        return true; // client gone
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        false
                    };

                    let client = async {
                        while let Some(msg) = source.next().await {
                            match msg {
                                Ok(Message::Close(_)) | Err(_) => return true,
                                _ => {}
                            }
                        }
                        true
                    };

                    tokio::select! {
                        gone = pump => {
                            kill_child(&slot).await;
                            if gone {
                                client_gone = true;
                            } else {
                                // fMP4 重新开流会再发 ftyp/moov，同一 MediaSource 无法续接；关 WS 让前端重连
                                eprintln!("[rtsp-proxy] ffmpeg ended, closing ws for reconnect…");
                                let _ = sink.close().await;
                                client_gone = true;
                            }
                        }
                        gone = client => {
                            kill_child(&slot).await;
                            if gone {
                                client_gone = true;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn spawn_ffmpeg(ffmpeg_path: &Path, rtsp_url: &str) -> Result<Child> {
    // fMP4：配合前端 MSE + <video>。frag_duration 控制分片间隔，避免仅按关键帧切片时 GOP 内卡最后一帧
    let mut cmd = Command::new(ffmpeg_path);
    cmd.kill_on_drop(true)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer+genpts",
            "-flags",
            "low_delay",
            "-avioflags",
            "direct",
            "-rtsp_transport",
            "tcp",
            "-i",
            rtsp_url,
            "-an",
            "-c:v",
            "copy",
            "-f",
            "mp4",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
            "-frag_duration",
            "500000",
            "-flush_packets",
            "1",
            "-",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .with_context(|| format!("spawn {}", ffmpeg_path.display()))
}

async fn kill_child(slot: &Arc<Mutex<Option<Child>>>) {
    let mut child = slot.lock().take();
    if let Some(ref mut c) = child {
        let _ = c.kill().await;
        let _ = c.wait().await;
    }
}

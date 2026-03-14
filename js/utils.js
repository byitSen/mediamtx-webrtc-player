export function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}-${mi}-${ss}`,
  };
}

/** 从 data URL 中取出纯 base64 字符串（供 Tauri 写入文件用） */
export function dataUrlToBase64(dataUrl) {
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

/** 浏览器环境下通过 <a download> 触发下载 */
export async function saveImageToPath(fullPath, dataUrl) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = fullPath;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

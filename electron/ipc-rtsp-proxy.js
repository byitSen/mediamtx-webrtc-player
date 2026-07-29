const { ipcMain } = require("electron");
const proxyManager = require("./rtsp-proxy");

function registerRtspProxyIpc() {
  ipcMain.handle("rtsp-proxy:create", async (_, rtspUrl) => {
    try {
      const wsUrl = await proxyManager.createProxy(rtspUrl);
      return { success: true, data: wsUrl };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  });

  ipcMain.handle("rtsp-proxy:destroy", async (_, rtspUrl) => {
    try {
      proxyManager.destroyProxy(rtspUrl);
      return { success: true };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  });

  ipcMain.handle("rtsp-proxy:destroy-all", async () => {
    try {
      proxyManager.destroyAll();
      return { success: true };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  });
}

module.exports = { registerRtspProxyIpc, proxyManager };

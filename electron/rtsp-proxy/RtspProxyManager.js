const RtspProxy = require("./RtspProxy");

class RtspProxyManager {
  constructor() {
    this.proxies = new Map();
    this.startPort = 19000;
    this.maxProxies = 16;
  }

  setMaxProxies(n) {
    const v = parseInt(n, 10);
    if (Number.isFinite(v) && v > 0) {
      this.maxProxies = Math.min(16, v);
    }
  }

  /**
   * @param {string} rtspUrl
   * @returns {Promise<string>} wsUrl
   */
  async createProxy(rtspUrl) {
    const url = String(rtspUrl || "").trim();
    if (!url) throw new Error("rtspUrl 为空");
    if (!/^rtsps?:\/\//i.test(url)) {
      throw new Error("无效的 RTSP 地址");
    }

    if (this.proxies.has(url)) {
      const existing = this.proxies.get(url);
      if (existing.isRunning && existing.wsUrl) return existing.wsUrl;
      this.destroyProxy(url);
    }

    if (this.proxies.size >= this.maxProxies) {
      throw new Error(`超出最大并发路数限制: ${this.maxProxies}`);
    }

    const port = this._getAvailablePort();
    const proxy = new RtspProxy(url, port);

    try {
      const wsUrl = await proxy.start();
      this.proxies.set(url, proxy);
      return wsUrl;
    } catch (e) {
      proxy.stop();
      throw e;
    }
  }

  destroyProxy(rtspUrl) {
    const url = String(rtspUrl || "").trim();
    const proxy = this.proxies.get(url);
    if (proxy) {
      proxy.stop();
      this.proxies.delete(url);
    }
  }

  destroyAll() {
    this.proxies.forEach((proxy) => {
      try {
        proxy.stop();
      } catch (_) {}
    });
    this.proxies.clear();
  }

  _getAvailablePort() {
    let port = this.startPort;
    const usedPorts = Array.from(this.proxies.values()).map((p) => p.port);
    while (usedPorts.includes(port)) {
      port += 1;
    }
    return port;
  }
}

module.exports = new RtspProxyManager();

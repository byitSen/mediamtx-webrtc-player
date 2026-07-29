const MAX_ACTIVE_DEFAULT = 8;

let maxActive = MAX_ACTIVE_DEFAULT;
const activeCameraIds = new Set();

function cameraKey(player) {
  if (!player || !player.camera) return "";
  return player.camera.rtspUrl || player.camera.path || player.camera.id || "";
}

export function setMaxActiveConnections(n) {
  const v = parseInt(n, 10);
  if (Number.isFinite(v) && v > 0) {
    maxActive = Math.min(16, v);
  }
}

export function tryActivate(player) {
  const id = cameraKey(player);
  if (!id) return false;
  if (activeCameraIds.has(id)) return true;
  if (activeCameraIds.size >= maxActive) return false;
  activeCameraIds.add(id);
  return true;
}

export function deactivate(player) {
  const id = cameraKey(player);
  if (!id) return;
  activeCameraIds.delete(id);
}

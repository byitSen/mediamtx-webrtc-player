const MAX_ACTIVE_DEFAULT = 8;

let maxActive = MAX_ACTIVE_DEFAULT;
const activeCameraPaths = new Set();

export function setMaxActiveConnections(n) {
  const v = parseInt(n, 10);
  if (Number.isFinite(v) && v > 0) {
    maxActive = v;
  }
}

export function tryActivate(player) {
  if (!player || !player.camera) return false;
  const id = player.camera.path || player.camera.id;
  if (!id) return false;
  if (activeCameraPaths.has(id)) return true;
  if (activeCameraPaths.size >= maxActive) return false;
  activeCameraPaths.add(id);
  return true;
}

export function deactivate(player) {
  if (!player || !player.camera) return;
  const id = player.camera.path || player.camera.id;
  if (!id) return;
  activeCameraPaths.delete(id);
}

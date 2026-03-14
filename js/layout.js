import { Player } from "./player.js";
import { getEffectiveSettings } from "./config.js";
import { registerPlayerCard } from "./visibility.js";

const playerInstances = [];

export function applyGridColumns(gridEl, n) {
  if (!gridEl) return;
  const cols = Math.max(1, Math.min(6, n || 3));
  gridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
}

export function initPlayers(gridEl, camerasFromArg) {
  playerInstances.forEach((p) => p.destroy());
  playerInstances.length = 0;
  if (!gridEl) return;
  gridEl.innerHTML = "";

  const cfg = getEffectiveSettings();
  const cameras = camerasFromArg && camerasFromArg.length ? camerasFromArg : cfg.cameras || [];

  cameras.forEach((cam) => {
    const card = document.createElement("div");
    card.className = "player-card";
    gridEl.appendChild(card);
    const player = new Player(card, cam);
    registerPlayerCard(card, player);
    playerInstances.push(player);
  });
}

export function getPlayerInstances() {
  return playerInstances;
}

import { tryActivate, deactivate } from "./webrtc-pool.js";

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const card = entry.target;
      const player = card.__playerInstance;
      if (!player) return;
      if (entry.isIntersecting) {
        if (tryActivate(player)) {
          // 进入视口且池中有配额，建立连接
          player.connect();
        } else {
          // 连接池已满，提示用户
          player.setStatus("not_ready", "连接池已满，暂不拉流");
        }
      } else {
        // 滚出视口，释放连接并归还配额
        deactivate(player);
        player.closePeer();
      }
    });
  },
  {
    root: null,
    rootMargin: "200px",
    threshold: 0.1,
  }
);

export function registerPlayerCard(cardEl, player) {
  cardEl.__playerInstance = player;
  observer.observe(cardEl);
}

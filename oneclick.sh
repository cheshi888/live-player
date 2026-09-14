#!/usr/bin/env bash
# oneclick.sh — 一键拉取并部署 (在已有 live-player 目录内运行, 或任意目录克隆后运行)
# 用法:
#   首次部署:  git clone https://github.com/cheshi888/live-player.git && cd live-player && ./oneclick.sh
#   一行命令:  cd live-player && sh <(curl -s https://raw.githubusercontent.com/cheshi888/live-player/main/oneclick.sh)
#   更新部署:  ./oneclick.sh   (git pull + 重启)
set -e

REPO_URL="https://github.com/cheshi888/live-player.git"
REPO_NAME="live-player"

# 判断是否在仓库目录内
if [ -f server.js ]; then
  echo "[oneclick] 检测到已在 live-player 目录, 拉取更新 …"
  git pull --ff-only || { echo "git pull 失败, 继续用本地代码"; }
elif [ -f "README.md" ] && [ -d .git ]; then
  echo "[oneclick] 拉取更新 …"
  git pull --ff-only || true
else
  # 不在仓库内 → 克隆
  if [ -d "$REPO_NAME/.git" ]; then
    cd "$REPO_NAME"
    echo "[oneclick] 已存在 $REPO_NAME 目录, 拉取更新 …"
    git pull --ff-only || true
  else
    echo "[oneclick] 克隆 $REPO_URL …"
    git clone "$REPO_URL"
    cd "$REPO_NAME"
  fi
fi

echo ""
echo "=============================================="
echo " 91CG 实时播放器 v3 · 拉取完成, 开始部署"
echo " 目录: $(pwd)"
echo "=============================================="

# 若没有 deploy.sh(极少见), 直接走启动逻辑
if [ -f deploy.sh ]; then
  ./deploy.sh
else
  # 兜底: 直接启动
  if ! command -v node >/dev/null 2>&1; then
    echo "✗ 未检测到 Node.js, 请先安装 Node.js >= 18"; exit 1
  fi
  PORT="${PORT:-8090}"; export PORT
  if command -v fuser >/dev/null 2>&1; then fuser -k "${PORT}/tcp" 2>/dev/null || true; fi
  nohup node server.js > server.log 2>&1 &
  echo $! > server.pid
  echo "已启动, 访问 http://localhost:${PORT}/"
fi

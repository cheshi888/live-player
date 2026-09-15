#!/usr/bin/env bash
# deploy.sh — 一键部署 (克隆/更新 + 启动 + 健康检查)
# 用法:
#   首次:  git clone <repo> && cd <dir> && ./deploy.sh
#   更新:  git pull && ./deploy.sh
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8090}"
export PORT

echo "=============================================="
echo " 91CG 实时播放器 v3 · 一键部署"
echo "=============================================="

# 1) 检查 Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js, 请先安装 Node.js >= 18 (https://nodejs.org)"; exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js 版本过低 ($(node -v)), 需要 >= 18"; exit 1
fi
echo "✓ Node.js $(node -v)"

# 2) 停止旧实例(按端口)
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
elif command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti:"${PORT}" 2>/dev/null || true)
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true
  sleep 1
fi
rm -f server.pid

# 3) 后台启动
nohup node server.js > server.log 2>&1 &
PID=$!
echo $PID > server.pid
echo "已启动 (pid ${PID}), 日志: $(pwd)/server.log"

# 4) 健康检查 (最多 30s)
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    echo ""
    echo "=============================================="
    echo " ✓ 部署成功"
    echo "   访问地址: http://localhost:${PORT}/"
    echo "   源列表:   http://localhost:${PORT}/api/sources"
    echo "   状态:     http://localhost:${PORT}/api/status"
    echo "   日志:     $(pwd)/server.log"
    echo ""
    echo "   7×24 常驻: 双档刷新(直播 ${REFRESH_SEC:-180}s / 回放 ${REPLAY_REFRESH_SEC:-1800}s)"
    echo "   单条自愈 + 进程级崩溃兜底 + 看门狗已启用"
    echo "=============================================="
    exit 0
  fi
  sleep 1
done
echo "✗ 30s 内未健康, 查看 server.log"; tail -n 40 server.log; exit 1

#!/usr/bin/env bash
# oneclick.sh — 一键拉取并部署
# 不依赖 ./ 可执行权限(用 sh 调用), 兼容 Ubuntu/CentOS/macOS
# 最终只输出: 部署成功与否 + 访问地址
set -e

REPO_URL="https://github.com/cheshi888/live-player.git"
REPO_NAME="live-player"

# ---------- 定位代码目录 ----------
if [ -f server.js ]; then
  echo "[oneclick] 已在 live-player 目录, 拉取更新 …"
  git pull --ff-only 2>/dev/null || true
elif [ -d "$REPO_NAME/.git" ]; then
  cd "$REPO_NAME"
  echo "[oneclick] 已存在 $REPO_NAME, 拉取更新 …"
  git pull --ff-only 2>/dev/null || true
else
  echo "[oneclick] 克隆 $REPO_URL …"
  git clone -q "$REPO_URL"
  cd "$REPO_NAME"
fi

if [ ! -f server.js ]; then
  echo ""
  echo "=========================================="
  echo " ✗ 部署失败: 代码目录异常(缺 server.js)"
  echo "=========================================="
  exit 1
fi

# ---------- Node.js 检查 ----------
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "=========================================="
  echo " ✗ 部署失败: 未检测到 Node.js"
  echo "   请安装 Node.js >= 18: https://nodejs.org"
  echo "=========================================="
  exit 1
fi

PORT="${PORT:-8090}"
export PORT

# ---------- 停止旧实例 ----------
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
elif command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti:"${PORT}" 2>/dev/null || true)
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true
  sleep 1
fi
rm -f server.pid

# ---------- 后台启动 ----------
nohup node server.js > server.log 2>&1 &
PID=$!
echo $PID > server.pid

# ---------- 健康检查(最多 30s) ----------
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    # ---------- 成功: 只打印结果 + 链接 ----------
    echo ""
    echo "=========================================="
    echo " ✓ 部署成功  (pid ${PID}, Node $(node -v))"
    echo ""
    echo "   访问地址: http://localhost:${PORT}/"
    echo "   状态:     http://localhost:${PORT}/api/status"
    echo "   日志:     $(pwd)/server.log"
    echo ""
    echo "   停止:     kill \$(cat $(pwd)/server.pid)"
    echo "=========================================="
    exit 0
  fi
  sleep 1
done

# ---------- 失败 ----------
echo ""
echo "=========================================="
echo " ✗ 部署失败: 30s 内未通过健康检查"
echo "   查看日志: $(pwd)/server.log"
echo "=========================================="
tail -n 20 server.log 2>/dev/null || true
exit 1

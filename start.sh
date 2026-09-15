#!/usr/bin/env bash
# start.sh — Linux/macOS 一键启动 (后台常驻 + 日志)
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8090}"
export PORT

# 若已有实例在跑则复用(幂等)
if curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  echo "已有实例在运行: http://localhost:${PORT}/"
  exit 0
fi

nohup node server.js > server.log 2>&1 &
PID=$!
echo $PID > server.pid
echo "已启动 (pid ${PID}), 日志: $(pwd)/server.log"

# 健康检查
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    echo "✓ 服务健康: http://localhost:${PORT}/"
    exit 0
  fi
  sleep 1
done
echo "✗ 30s 内未健康, 查看 server.log"; exit 1

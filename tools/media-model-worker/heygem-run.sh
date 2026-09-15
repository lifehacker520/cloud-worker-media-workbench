#!/bin/bash
# HeyGem 单条生成远端执行器（平台 Worker 调用）
# 用法: bash heygem-run.sh <audio> <video> <outName>
set -u
AUDIO="$1"; VIDEO="$2"; OUT="$3"
HEYGEM_DIR="${HEYGEM_DIR:-/root/HeyGem-Linux-Python-Hack}"
PY="${HEYGEM_PY:-/root/miniconda3/bin/python}"
LOCK=/root/.heygem-lock
INPUTS=/root/inputs
OUTPUTS=/root/outputs

# 1) 陈旧锁回收（>45 分钟视为残留）
if [ -d "$LOCK" ]; then
  if [ -z "$(pgrep -f '[r]un.py --audio_path' 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true   # 无进程持有 → 残留锁，立即回收
  elif [ -n "$(find "$LOCK" -maxdepth 0 -mmin +45 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true   # 超 45 分钟 → 视为残留
  fi
fi
# 2) 原子抢占互斥锁
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "LOCKED_BY_OTHER_RUN"
  exit 9
fi
# 3) 清理孤儿生成进程（避免并发争用）
pkill -f "run.py --audio_path" 2>/dev/null || true
sleep 1
# 4) 起新任务
cd "$HEYGEM_DIR" || { echo "HEYGEM_DIR_MISSING"; rmdir "$LOCK"; exit 10; }
BASE="$(basename "$VIDEO")"; BASE="${BASE%.*}"
rm -f "$OUTPUTS/${BASE}_output-r.mp4"
date +%s > "/root/.gen-started-${OUT}"
nohup bash -c "'$PY' run.py --audio_path '$AUDIO' --video_path '$VIDEO' > '/root/gen-${OUT}.log' 2>&1; rmdir '$LOCK' 2>/dev/null" < /dev/null &
echo "STARTED base=${BASE} out=${OUTPUTS}/${BASE}_output-r.mp4"
exit 0

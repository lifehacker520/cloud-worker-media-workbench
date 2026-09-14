#!/usr/bin/env python3
"""豆包语音合成 2.0（新版 v3 单向流式）真实调用测试——S7-02。

从 data/secrets/doubao-tts.json 读 token（新版 API Key），
POST https://openspeech.bytedance.com/api/v3/tts/unidirectional，
解析二进制分块流，落成 mp3。
"""
import json
import struct
import sys
import urllib.request
import uuid
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[3] / "data" / "secrets" / "doubao-tts.json"
TEXT = "很多人以为公司发工作手机是福利，其实是把工作和生活绑在了一起。今天我用一分钟，给你讲清楚这背后真正的逻辑。看完你就明白，为什么越来越多的公司开始统一管理工作手机了。"
OUT = Path("data/media-output/houyunlong-cloned-voice-sample.mp3")


def main():
    config = json.loads(CONFIG.read_text("utf-8"))
    token = (config.get("token") or "").strip()
    speaker = (config.get("clonedSpeakerId") or "S_C8a62LEV1").strip()
    payload = {
        "user": {"uid": "cloud-worker-content-editor"},
        "req_params": {
            "model": "seed-tts-2.0-standard",
            "text": TEXT,
            "speaker": speaker,
            "audio_params": {"format": "mp3", "sample_rate": 24000},
        },
    }
    request = urllib.request.Request(
        "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": token,
            "X-Api-Resource-Id": "seed-icl-2.0",
            "X-Api-Request-Id": str(uuid.uuid4()),
        },
        method="POST",
    )
    try:
        response = urllib.request.urlopen(request, timeout=90)
    except urllib.error.HTTPError as error:
        print(json.dumps({
            "httpError": error.code,
            "body": error.read().decode("utf-8", "replace")[:600],
        }, ensure_ascii=False))
        sys.exit(1)
    raw = response.read()
    # 响应是分块 JSON 流：每块 {"code":0,"data":"<base64>"}，拼接全部 data 再解码
    import re
    import base64 as b64mod
    parts = re.findall(rb'"data":"([^"]*)"', raw)
    audio_bytes = b64mod.b64decode(''.join(part.decode('ascii') for part in parts)) if parts else b''
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(audio_bytes)
    print(json.dumps({
        'ok': len(audio_bytes) > 1000,
        'audioBytes': len(audio_bytes),
        'out': str(OUT),
        'chunks': len(parts),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()

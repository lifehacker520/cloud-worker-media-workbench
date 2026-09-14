#!/usr/bin/env python3
"""豆包声音复刻 V3 训练接口（新版 API Key 鉴权）——S7-02。

POST https://openspeech.bytedance.com/api/v3/tts/voice_clone
Headers: X-Api-Key + X-Api-Request-Id
训练通过后同一音色可同时在声音复刻1.0/2.0/端到端实时语音上使用（多账号多数字人正合适）。

stdin: {"audio_file": "/abs/ref.wav", "text": "参考文本(可选)", "speaker_id": "S_xxx(可选)"}
stdout: {"ok": ..., "speakerId": ...} 或 {"ok": false, "httpError", "body"}
"""

import base64
import json
import os
import sys
import urllib.request
import urllib.error
import uuid
from pathlib import Path

CONFIG_CANDIDATES = [
    os.environ.get("DOUBAO_TTS_CONFIG", ""),
    str(Path(__file__).resolve().parents[3] / "data" / "secrets" / "doubao-tts.json"),
]


def load_config():
    for candidate in CONFIG_CANDIDATES:
        if candidate and Path(candidate).exists():
            return json.loads(Path(candidate).read_text("utf-8"))
    raise RuntimeError("缺少配置文件 data/secrets/doubao-tts.json")


def main():
    request = json.loads(sys.stdin.read() or "{}")
    audio_file = request.get("audio_file")
    text = (request.get("text") or "").strip()
    if not audio_file or not Path(audio_file).exists():
        print(json.dumps({"ok": False, "error": "缺少参考音频", "code": "AUDIO_MISSING"}, ensure_ascii=False))
        return

    config = load_config()
    token = (config.get("token") or "").strip()
    speaker_id = (request.get("speaker_id") or ("S_" + uuid.uuid4().hex[:12]))
    audio_path = Path(audio_file)
    audio_format = audio_path.suffix.lstrip(".").lower() or "wav"
    audio_b64 = base64.b64encode(audio_path.read_bytes()).decode("utf-8")

    body = {
        "speaker_id": speaker_id,
        "model_type": 4,
        "audio": {"data": audio_b64, "format": audio_format},
    }
    if text:
        body["audio"]["text"] = text

    http = urllib.request.Request(
        "https://openspeech.bytedance.com/api/v3/tts/voice_clone",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": token,
            "X-Api-Request-Id": str(uuid.uuid4()),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(http, timeout=180) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        print(json.dumps({"ok": False, "httpError": error.code, "body": error.read().decode("utf-8", "replace")[:600]}, ensure_ascii=False))
        return
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error), "code": "NETWORK"}, ensure_ascii=False))
        return

    try:
        parsed = json.loads(raw)
    except Exception:
        parsed = {"raw": raw[:600]}
    print(json.dumps({"ok": True, "speakerId": speaker_id, "response": parsed}, ensure_ascii=False))


if __name__ == "__main__":
    main()

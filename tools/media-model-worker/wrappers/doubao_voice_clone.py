#!/usr/bin/env python3
"""豆包声音复刻 2.0 受控 wrapper——S7-02：员工专属音色训练。

契约（与 worker command mode 一致）：
  stdin: {"audio_file": "/abs/ref.wav", "text": "参考音频的准确文本", "speaker_id": "S_xxx(可选)"}
  stdout: {"ok": true, "speakerId": "S_xxx"} 或 {"ok": false, "error", "code"}

API：POST https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload
  Authorization: Bearer;{access_token}
  Resource-Id: seed-icl-2.0
  Body: {speaker_id, appid, audios:[{audio_bytes(base64), text, audio_format}], model_type: 4, source: 2}
  model_type=4 → 声音复刻 ICL V2 效果（2.0）
训练为分钟级生效；同一 speaker_id 最多训练 10 次。
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
        print(json.dumps({"ok": False, "error": "缺少参考音频文件", "code": "AUDIO_MISSING"}, ensure_ascii=False))
        return
    if not text:
        print(json.dumps({"ok": False, "error": "缺少参考音频对应的准确文本（服务会做 WER 比对）", "code": "TEXT_MISSING"}, ensure_ascii=False))
        return

    config = load_config()
    token = (config.get("token") or "").strip()
    appid = (config.get("cloneAppid") or config.get("appid") or "").strip()
    resource = (config.get("cloneResource") or "seed-icl-2.0").strip()
    speaker_id = (request.get("speaker_id") or config.get("cloneSpeakerId") or ("S_" + uuid.uuid4().hex[:12])).strip()

    audio_path = Path(audio_file)
    audio_format = audio_path.suffix.lstrip(".").lower() or "wav"
    audio_b64 = base64.b64encode(audio_path.read_bytes()).decode("utf-8")

    payload = {
        "speaker_id": speaker_id,
        "appid": appid,
        "audios": [{"audio_bytes": audio_b64, "text": text, "audio_format": audio_format}],
        "model_type": 4,
        "source": 2,
    }
    http = urllib.request.Request(
        "https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer;" + token,
            "Resource-Id": resource,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(http, timeout=120) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        print(json.dumps({"ok": False, "error": f"HTTP {error.code}: " + error.read().decode("utf-8", "replace")[:400], "code": "DOUBAO_HTTP_ERROR"}, ensure_ascii=False))
        return
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error), "code": "DOUBAO_NETWORK_ERROR"}, ensure_ascii=False))
        return

    if body.get("code") not in (0, 2000, 2001, "0", "2000", "2001"):
        print(json.dumps({"ok": False, "error": f"豆包返回 code={body.get('code')} message={body.get('message')}", "code": "DOUBAO_API_ERROR", "raw": body}, ensure_ascii=False))
        return

    print(json.dumps({
        "ok": True,
        "speakerId": speaker_id,
        "resource": resource,
        "note": "训练分钟级生效；合成时 Resource-Id 用 seed-icl-2.0、speaker 用该 ID、model 用 seed-tts-2.0-icl",
        "raw": body,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()

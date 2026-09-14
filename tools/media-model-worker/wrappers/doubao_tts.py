#!/usr/bin/env python3
"""豆包（火山引擎）TTS 受控 wrapper——S7-02 真实声音接入。

命令桥接契约（与 tools/media-model-worker 的 command mode 一致）：
  stdin  收一个 JSON 请求：{"text": "...", "voice": "...(可选)", "out_file": "...(可选)"}
  stdout 输出一个 JSON 结果：{"ok": true, "file": "/受控路径/x.mp3", "provider": "doubao-tts",
                              "voice": "...", "durationHint": null}
       或 {"ok": false, "error": "...", "code": "..."}

配置读取（按优先级）：
  1. 环境变量 DOUBAO_TTS_CONFIG 指向的 JSON 文件
  2. 仓库内 data/secrets/doubao-tts.json（gitignore 覆盖，不入库）
密钥/appid 永远不出现在本文件或任何入库文件里。
"""

import base64
import json
import os
import sys
import urllib.request
import urllib.error
import uuid
from pathlib import Path

DEFAULT_CONFIG_CANDIDATES = [
    os.environ.get("DOUBAO_TTS_CONFIG", ""),
    str(Path(__file__).resolve().parents[3] / "data" / "secrets" / "doubao-tts.json"),
]


def load_config():
    for candidate in DEFAULT_CONFIG_CANDIDATES:
        if candidate and Path(candidate).exists():
            with open(candidate, "r", encoding="utf-8") as handle:
                return json.load(handle)
    raise RuntimeError(
        "缺少豆包 TTS 配置：请创建 data/secrets/doubao-tts.json（token/appid/cluster/voice），"
        "或设置 DOUBAO_TTS_CONFIG 环境变量指向配置文件"
    )


def call_doubao_tts(config, text, voice_override=None, out_file=None):
    token = (config.get("token") or "").strip()
    appid = (config.get("appid") or "").strip()
    cluster = (config.get("cluster") or "volcano_tts").strip()
    voice = (voice_override or config.get("voice") or "").strip()
    endpoint = (config.get("endpoint") or "https://openspeech.bytedance.com/api/v1/tts").strip()
    if not token:
        return {"ok": False, "error": "配置缺少 token", "code": "DOUBAO_TOKEN_MISSING"}
    if not voice:
        return {"ok": False, "error": "配置缺少 voice（音色）", "code": "DOUBAO_VOICE_MISSING"}

    payload = {
        "app": {"appid": appid, "token": "access_token", "cluster": cluster},
        "user": {"uid": "cloud-worker-content-editor"},
        "audio": {"voice_type": voice, "encoding": "mp3", "speed_ratio": 1.0},
        "request": {"reqid": str(uuid.uuid4()), "text": text, "text_type": "plain", "operation": "query"},
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer;" + token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        return {"ok": False, "error": f"HTTP {error.code}: {detail}", "code": "DOUBAO_HTTP_ERROR"}
    except Exception as error:  # noqa: BLE001 - 网络层错误统一上报
        return {"ok": False, "error": str(error), "code": "DOUBAO_NETWORK_ERROR"}

    if body.get("code") not in (0, 2000, 2001, "0", "2000", "2001"):
        return {"ok": False, "error": f"豆包返回错误 code={body.get('code')} message={body.get('message')}", "code": "DOUBAO_API_ERROR"}

    audio_b64 = body.get("data")
    if not audio_b64:
        return {"ok": False, "error": "豆包返回成功但没有音频数据", "code": "DOUBAO_EMPTY_AUDIO"}

    audio_bytes = base64.b64decode(audio_b64)
    output = Path(out_file) if out_file else Path(os.environ.get("DOUBAO_TTS_OUT_DIR", ".")) / f"doubao-tts-{uuid.uuid4().hex[:8]}.mp3"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(audio_bytes)
    return {
        "ok": True,
        "file": str(output.resolve()),
        "provider": "doubao-tts",
        "voice": voice,
        "bytes": len(audio_bytes),
    }


def main():
    try:
        raw = sys.stdin.read() or "{}"
        request = json.loads(raw)
        text = (request.get("text") or "").strip()
        if not text:
            print(json.dumps({"ok": False, "error": "请求缺少 text", "code": "TEXT_MISSING"}))
            return
        config = load_config()
        result = call_doubao_tts(config, text, request.get("voice"), request.get("out_file"))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error), "code": "WRAPPER_ERROR"}, ensure_ascii=False))


if __name__ == "__main__":
    main()

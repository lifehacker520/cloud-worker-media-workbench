"""A local, non-cloning TTS baseline for validating the media-worker path."""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


PROTOCOL = "content-media-worker-v1"
VOICE_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def fail(message):
    raise ValueError(message)


def main():
    request = json.load(sys.stdin)
    if request.get("protocol") != PROTOCOL:
        fail("媒体 worker 协议版本不匹配")
    if request.get("operation") != "tts":
        fail("macOS say wrapper 只支持 tts")
    inputs = request.get("input")
    script = inputs.get("scriptText", "").strip() if isinstance(inputs, dict) else ""
    if not script or len(script) > 30_000 or "\x00" in script:
        fail("口播稿必须是 1 至 30000 个不含 NUL 的字符")

    voice = os.environ.get("MEDIA_WORKER_MACOS_SAY_VOICE", "Ting-Ting").strip()
    if not VOICE_PATTERN.fullmatch(voice):
        fail("macOS say voice 名称不合法")
    root = Path(os.environ.get("MEDIA_WORKER_DATA_DIR", Path(__file__).resolve().parents[1] / "data")).resolve()
    output_dir = root / "macos-say"
    output_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(json.dumps({
        "idempotencyKey": request.get("idempotencyKey", ""),
        "scriptText": script,
        "voice": voice,
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:24]
    aiff_path = output_dir / (digest + ".aiff")
    wav_path = output_dir / (digest + ".wav")

    if not wav_path.is_file() or wav_path.stat().st_size <= 1_000:
        say = shutil.which("say") or "/usr/bin/say"
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            fail("未找到 ffmpeg，无法把 macOS say 输出转换为 WAV")
        try:
            subprocess.run(
                [say, "-v", voice, "-o", str(aiff_path), script],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
            subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(aiff_path),
                 "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(wav_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
        finally:
            aiff_path.unlink(missing_ok=True)

    if not wav_path.is_file() or wav_path.stat().st_size <= 1_000:
        fail("macOS say 未生成有效 WAV 文件")
    print(json.dumps({
        "protocol": PROTOCOL,
        "requestId": "macos-say-request-" + digest,
        "taskId": "macos-say-task-" + digest,
        "output": {
            "outputKind": "audio",
            "audioRef": wav_path.as_uri(),
            "modelVersion": "system-tts-baseline",
            "voiceName": voice,
            "engine": "macOS say",
            "simulated": False,
            "reviewRequired": True,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)

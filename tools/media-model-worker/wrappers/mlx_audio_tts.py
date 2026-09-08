"""Run an explicitly configured mlx-audio TTS/voice-clone command."""

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse


PROTOCOL = "content-media-worker-v1"
VOICE_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
LANGUAGES = {
    "zh": "Chinese",
    "zh-CN": "Chinese",
    "en": "English",
    "en-US": "English",
    "ja": "Japanese",
    "ko": "Korean",
}


def fail(message):
    raise ValueError(message)


def command(value):
    parts = shlex.split(value or "mlx_audio.tts.generate")
    return parts or ["mlx_audio.tts.generate"]


def local_reference(value, root):
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme != "file":
        fail("MLX 声音克隆只接受受控目录内的 file:// 参考音频")
    path = Path(unquote(parsed.path)).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError("参考音频必须位于媒体 worker 受控目录") from error
    if not path.is_file():
        fail("参考音频文件不存在")
    return path


def valid_wav(path):
    try:
        return path.is_file() and path.stat().st_size > 1_000
    except OSError:
        return False


def main():
    request = json.load(sys.stdin)
    if request.get("protocol") != PROTOCOL:
        fail("媒体 worker 协议版本不匹配")
    if request.get("operation") != "tts":
        fail("mlx-audio wrapper 只支持 tts")
    inputs = request.get("input")
    if not isinstance(inputs, dict):
        fail("请求缺少 input 对象")
    script = str(inputs.get("scriptText", "")).strip()
    if not script or len(script) > 30_000 or "\x00" in script:
        fail("口播稿必须是 1 至 30000 个不含 NUL 的字符")

    model = os.environ.get("MEDIA_WORKER_MLX_AUDIO_MODEL", "").strip()
    if not model or "\x00" in model:
        fail("必须配置 MEDIA_WORKER_MLX_AUDIO_MODEL")
    mode = os.environ.get("MEDIA_WORKER_MLX_AUDIO_MODE", "clone").strip().lower()
    if mode not in {"clone", "custom"}:
        fail("MEDIA_WORKER_MLX_AUDIO_MODE 只能是 clone 或 custom")
    root = Path(os.environ.get("MEDIA_WORKER_DATA_DIR", Path(__file__).resolve().parents[1] / "data")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    voice = inputs.get("voice") if isinstance(inputs.get("voice"), dict) else {}
    voice_name = str(voice.get("voiceName") or os.environ.get("MEDIA_WORKER_MLX_AUDIO_VOICE", "")).strip()
    reference = str(voice.get("referenceAudioRef") or "").strip()
    reference_text = str(voice.get("referenceTranscript") or voice.get("referenceText") or os.environ.get("MEDIA_WORKER_MLX_AUDIO_REF_TEXT", "")).strip()
    language = LANGUAGES.get(str(inputs.get("language", "zh-CN")).strip(), str(inputs.get("language", "zh-CN")).strip())
    if not language or "\x00" in language:
        fail("语言参数不合法")

    digest = hashlib.sha256(json.dumps({
        "idempotencyKey": request.get("idempotencyKey", ""),
        "model": model,
        "mode": mode,
        "scriptText": script,
        "voiceName": voice_name,
        "referenceAudioRef": reference,
        "referenceText": reference_text,
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:24]
    output_dir = root / "mlx-audio" / digest
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "audio.wav"

    if not valid_wav(output_path):
        args = command(os.environ.get("MEDIA_WORKER_MLX_AUDIO_COMMAND"))
        if not (Path(args[0]).is_file() if os.path.isabs(args[0]) else shutil.which(args[0])):
            fail("未找到 mlx-audio 命令；请在独立 Apple Silicon worker 环境配置 MEDIA_WORKER_MLX_AUDIO_COMMAND")
        command_args = args + [
            "--model", model,
            "--text", script,
            "--lang_code", language,
            "--output_path", str(output_dir),
            "--join_audio",
        ]
        if mode == "clone":
            reference_path = local_reference(reference, root)
            if not reference_text:
                fail("声音克隆必须提供参考音频对应的 referenceTranscript")
            command_args.extend(["--ref_audio", str(reference_path), "--ref_text", reference_text])
        else:
            if not voice_name or not VOICE_PATTERN.fullmatch(voice_name):
                fail("CustomVoice 必须配置合法的 voiceName 或 MEDIA_WORKER_MLX_AUDIO_VOICE")
            command_args.extend(["--voice", voice_name])
        try:
            completed = subprocess.run(
                command_args,
                check=False,
                capture_output=True,
                text=True,
                timeout=max(1, int(os.environ.get("MEDIA_WORKER_MLX_AUDIO_TIMEOUT_SECONDS", "600"))),
                shell=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError("mlx-audio 命令执行超时") from error
        except OSError as error:
            raise ValueError("mlx-audio 命令无法启动") from error
        if completed.returncode != 0:
            fail("mlx-audio 命令执行失败")
        generated = sorted(path for path in output_dir.rglob("*.wav") if valid_wav(path))
        if len(generated) != 1:
            fail("mlx-audio 必须在 --join_audio 后生成唯一 WAV 文件")
        generated[0].replace(output_path)

    if not valid_wav(output_path):
        fail("mlx-audio 未生成有效 WAV 文件")
    print(json.dumps({
        "protocol": PROTOCOL,
        "requestId": "mlx-audio-request-" + digest,
        "taskId": "mlx-audio-task-" + digest,
        "output": {
            "outputKind": "audio",
            "audioRef": output_path.as_uri(),
            "modelVersion": model,
            "engine": "mlx-audio",
            "runtime": "apple-mlx",
            "voiceMode": mode,
            "simulated": False,
            "reviewRequired": True,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)

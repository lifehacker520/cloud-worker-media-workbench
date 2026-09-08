"""Run a configured MuseTalk inference command behind the media-worker contract."""

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse


PROTOCOL = "content-media-worker-v1"
VERSION_ALIASES = {"v1": "v1", "v1.0": "v1", "v15": "v15", "v1.5": "v15"}


def fail(message):
    raise ValueError(message)


def command(value):
    parts = shlex.split(value or "python3 -m scripts.inference")
    return parts or ["python3", "-m", "scripts.inference"]


def safe_path(value, label):
    text = str(value or "").strip()
    if not text or "\x00" in text or "\n" in text or "\r" in text:
        fail(f"{label}路径不合法")
    return Path(text).expanduser()


def local_reference(value, root, label):
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme != "file" or parsed.netloc not in {"", "localhost"}:
        fail(f"{label}只接受受控目录内的 file:// 引用")
    path = Path(unquote(parsed.path)).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label}必须位于媒体 worker 受控目录") from error
    if not path.is_file() or path.stat().st_size <= 0:
        fail(f"{label}文件不存在或为空")
    return path


def configured_path(name, default, base):
    path = safe_path(os.environ.get(name, str(default)), name)
    return (base / path).resolve() if not path.is_absolute() else path.resolve()


def valid_video(path):
    try:
        if not path.is_file() or path.stat().st_size <= 1_000:
            return False
        return b"ftyp" in path.open("rb").read(128)
    except OSError:
        return False


def required_env(name, label):
    value = os.environ.get(name, "").strip()
    if not value or "\x00" in value or "\n" in value or "\r" in value:
        fail(f"必须配置 {name}（{label}）")
    return value


def main():
    request = json.load(sys.stdin)
    if request.get("protocol") != PROTOCOL:
        fail("媒体 worker 协议版本不匹配")
    if request.get("operation") not in {"talking_head", "batch_media"}:
        fail("MuseTalk wrapper 只支持 talking_head 或 batch_media")
    inputs = request.get("input")
    if not isinstance(inputs, dict):
        fail("请求缺少 input 对象")
    script = str(inputs.get("scriptText", "")).strip()
    if not script or len(script) > 30_000 or "\x00" in script:
        fail("口播稿必须是 1 至 30000 个不含 NUL 的字符")

    data_root = Path(os.environ.get("MEDIA_WORKER_DATA_DIR", Path(__file__).resolve().parents[1] / "data")).resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    model_root = safe_path(required_env("MEDIA_WORKER_MUSETALK_ROOT", "MuseTalk 代码和权重目录"), "MEDIA_WORKER_MUSETALK_ROOT")
    model_root = model_root.resolve()
    if not model_root.is_dir():
        fail("MuseTalk 运行目录不存在")

    avatar = inputs.get("avatar") if isinstance(inputs.get("avatar"), dict) else {}
    voice = inputs.get("voice") if isinstance(inputs.get("voice"), dict) else {}
    audio_path = local_reference(inputs.get("audioRef"), data_root, "口播音频")
    video_path = local_reference(avatar.get("baseVideoRef"), data_root, "数字人基础视频")
    if avatar.get("canonicalImageRef"):
        local_reference(avatar["canonicalImageRef"], data_root, "数字人参考图")
    if not str(avatar.get("authorizationRef") or "").strip():
        fail("数字人肖像授权引用缺失")
    if not str(voice.get("authorizationRef") or "").strip():
        fail("声音授权引用缺失")

    version_raw = os.environ.get("MEDIA_WORKER_MUSETALK_VERSION", "v15").strip().lower()
    version = VERSION_ALIASES.get(version_raw)
    if not version:
        fail("MEDIA_WORKER_MUSETALK_VERSION 只能是 v1 或 v15")
    model_version = required_env("MEDIA_WORKER_MUSETALK_MODEL_VERSION", "模型版本")
    weights_hash = required_env("MEDIA_WORKER_MUSETALK_WEIGHTS_HASH", "权重哈希")
    license_ref = required_env("MEDIA_WORKER_MUSETALK_LICENSE_REF", "模型许可证引用")

    default_unet = model_root / ("models/musetalkV15/unet.pth" if version == "v15" else "models/musetalk/pytorch_model.bin")
    default_config = model_root / ("models/musetalkV15/musetalk.json" if version == "v15" else "models/musetalk/musetalk.json")
    unet_path = configured_path("MEDIA_WORKER_MUSETALK_UNET_MODEL_PATH", default_unet, model_root)
    unet_config = configured_path("MEDIA_WORKER_MUSETALK_UNET_CONFIG", default_config, model_root)
    whisper_dir = configured_path("MEDIA_WORKER_MUSETALK_WHISPER_DIR", model_root / "models/whisper", model_root)
    if not unet_path.is_file() or unet_path.stat().st_size <= 0:
        fail("MuseTalk UNet 权重不存在")
    if not unet_config.is_file() or unet_config.stat().st_size <= 0:
        fail("MuseTalk UNet 配置不存在")
    if not whisper_dir.is_dir():
        fail("MuseTalk Whisper 模型目录不存在")

    digest = hashlib.sha256(json.dumps({
        "idempotencyKey": request.get("idempotencyKey", ""),
        "modelVersion": model_version,
        "version": version,
        "weightsHash": weights_hash,
        "videoRef": video_path.as_uri(),
        "audioRef": audio_path.as_uri(),
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:24]
    output_dir = data_root / "musetalk" / digest
    result_dir = output_dir / "results"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "talking_head.mp4"

    if not valid_video(output_path):
        if result_dir.exists():
            shutil.rmtree(result_dir)
        result_dir.mkdir(parents=True, exist_ok=True)
        config_path = output_dir / "inference.yaml"
        config_path.write_text(
            "task_0:\n"
            f"  video_path: {json.dumps(str(video_path), ensure_ascii=False)}\n"
            f"  audio_path: {json.dumps(str(audio_path), ensure_ascii=False)}\n",
            encoding="utf-8",
        )
        args = command(os.environ.get("MEDIA_WORKER_MUSETALK_COMMAND")) + [
            "--inference_config", str(config_path),
            "--result_dir", str(result_dir),
            "--unet_model_path", str(unet_path),
            "--unet_config", str(unet_config),
            "--whisper_dir", str(whisper_dir),
            "--version", version,
            "--fps", str(max(1, int(os.environ.get("MEDIA_WORKER_MUSETALK_FPS", "25")))),
            "--batch_size", str(max(1, int(os.environ.get("MEDIA_WORKER_MUSETALK_BATCH_SIZE", "8")))),
            "--output_vid_name", "talking_head.mp4",
        ]
        ffmpeg_path = os.environ.get("MEDIA_WORKER_MUSETALK_FFMPEG_PATH", "").strip()
        if ffmpeg_path:
            args.extend(["--ffmpeg_path", safe_path(ffmpeg_path, "MEDIA_WORKER_MUSETALK_FFMPEG_PATH").as_posix()])
        if os.environ.get("MEDIA_WORKER_MUSETALK_USE_FLOAT16", "false").strip().lower() in {"1", "true", "yes"}:
            args.append("--use_float16")
        try:
            completed = subprocess.run(
                args,
                cwd=model_root,
                check=False,
                capture_output=True,
                text=True,
                timeout=max(1, int(os.environ.get("MEDIA_WORKER_MUSETALK_TIMEOUT_SECONDS", "1800"))),
                shell=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError("MuseTalk 命令执行超时") from error
        except OSError as error:
            raise ValueError("MuseTalk 命令无法启动") from error
        if completed.returncode != 0:
            fail("MuseTalk 命令执行失败")
        generated = sorted(path for path in result_dir.rglob("*.mp4") if valid_video(path))
        if len(generated) != 1:
            fail("MuseTalk 必须生成唯一有效 MP4 文件")
        generated[0].replace(output_path)

    if not valid_video(output_path):
        fail("MuseTalk 未生成有效 MP4 文件")
    print(json.dumps({
        "protocol": PROTOCOL,
        "requestId": "musetalk-request-" + digest,
        "taskId": "musetalk-task-" + digest,
        "output": {
            "outputKind": "video",
            "videoRef": output_path.as_uri(),
            "modelVersion": model_version,
            "engine": "MuseTalk",
            "runtime": "nvidia-cuda",
            "version": version,
            "weightsHash": weights_hash,
            "licenseRef": license_ref,
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

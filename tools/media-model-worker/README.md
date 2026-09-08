# Media model worker

这是内容编辑批量数字人功能的独立 worker 边界。默认提供标准库 fake adapter：

```bash
python3 tools/media-model-worker/app.py --port 8765
```

在另一个终端启动客户端时设置：

```bash
XHS_MEDIA_WORKER_URL=http://127.0.0.1:8765 npm start
```

客户端会读取 `GET /health`，并把每个批次条目通过 `POST /v1/media/generate` 发送。fake adapter 的输出永远带 `simulated: true` 和 `simulation://` 引用；它只验证协议和队列，不替代 CosyVoice、OpenVoice 或 MuseTalk。

需要接入真实模型时，可以使用受控命令桥接，把具体模型留在独立 Python/GPU wrapper 中：

```bash
MEDIA_WORKER_MODE=command \
MEDIA_WORKER_TTS_COMMAND="python3 /opt/models/cosyvoice_wrapper.py" \
MEDIA_WORKER_AVATAR_COMMAND="python3 /opt/models/musetalk_wrapper.py" \
MEDIA_WORKER_DATA_DIR=/srv/cloud-worker/media \
python3 tools/media-model-worker/app.py --port 8765
```

每个 wrapper 通过 stdin 接收一个 JSON 请求并向 stdout 输出一个 JSON 对象；桥接器不经过 shell，支持 `tts`、`talking_head` 和 `batch_media`。`batch_media` 在 command mode 下会先执行 TTS，再把生成的受控 `audioRef` 交给 talking-head wrapper，避免数字人阶段凭空假设音频已经存在；因此真实批次必须同时配置 TTS 和 avatar command。真实输出可以是受控目录内的 `file://` 引用，也可以是已经授权的 HTTP/S3 引用；客户端只会把允许目录内的本地文件登记为可预览媒体资产。模型版本、权重哈希、许可证和人物/声音授权仍由 wrapper/部署方提供，不能用 command mode 本身代替审核。

MuseTalk 1.5 的受控 wrapper 会将 `input.avatar.baseVideoRef` 与 `input.audioRef` 写入单次 inference config，再以无 shell 命令调用官方 `scripts.inference`；当前只选择已有基础人物视频作为输入，不把三视图存在误认为已完成数字人建模。部署时需要独立 NVIDIA/CUDA 环境、模型权重、权重哈希和许可证引用：

```bash
MEDIA_WORKER_MODE=command \
MEDIA_WORKER_AVATAR_COMMAND="python3 tools/media-model-worker/wrappers/musetalk_talking_head.py" \
MEDIA_WORKER_MUSETALK_ROOT=/srv/models/MuseTalk \
MEDIA_WORKER_MUSETALK_MODEL_VERSION=musetalk-1.5 \
MEDIA_WORKER_MUSETALK_VERSION=v15 \
MEDIA_WORKER_MUSETALK_WEIGHTS_HASH=sha256:replace-me \
MEDIA_WORKER_MUSETALK_LICENSE_REF=license://musetalk-1.5 \
MEDIA_WORKER_DATA_DIR=/srv/cloud-worker/media \
python3 tools/media-model-worker/app.py --port 8765
```

wrapper 只接受受控目录内的本地音频/基础视频和已登记的肖像/声音授权，输出唯一的 `file://` MP4，并标记 `simulated:false`、`reviewRequired:true`。官方 MuseTalk 的环境、权重和推理参数需按 [MuseTalk 官方仓库](https://github.com/TMElyralab/MuseTalk) 单独部署；本仓库测试用 stub 只验证输入、安全边界、命令参数和幂等，不代表真实口型质量。

macOS 本机可以用系统 TTS 做真实音频文件链路基线（不是声音克隆，也不替代 CosyVoice/OpenVoice A/B）：

```bash
MEDIA_WORKER_MODE=command \
MEDIA_WORKER_TTS_COMMAND="python3 tools/media-model-worker/wrappers/macos_say_tts.py" \
MEDIA_WORKER_MACOS_SAY_VOICE=Ting-Ting \
MEDIA_WORKER_DATA_DIR=/tmp/cloud-worker-media \
python3 tools/media-model-worker/app.py --port 8765
```

Apple Silicon 可以把同一条 `tts` 合约接到 [MLX Audio](https://github.com/Blaizzy/mlx-audio)；其命令行支持 `--ref_audio`、`--ref_text` 和 `--join_audio`，仓库 wrapper 会把声音参考文本从已授权声音版本传入，并把输出限制在 Worker 受控目录：

```bash
MEDIA_WORKER_MODE=command \
MEDIA_WORKER_TTS_COMMAND="python3 tools/media-model-worker/wrappers/mlx_audio_tts.py" \
MEDIA_WORKER_MLX_AUDIO_COMMAND="mlx_audio.tts.generate" \
MEDIA_WORKER_MLX_AUDIO_MODEL="mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16" \
MEDIA_WORKER_MLX_AUDIO_MODE=clone \
MEDIA_WORKER_DATA_DIR=/tmp/cloud-worker-media \
python3 tools/media-model-worker/app.py --port 8765
```

`MEDIA_WORKER_MLX_AUDIO_MODEL` 必须显式配置；本仓库不会自动下载模型权重。模型、权重许可、参考音频授权和实际质量仍由独立部署提供；当前测试用 stub 只验证命令参数/幂等/受控文件，不代表 MLX 或 Qwen3-TTS 已在本机运行。需要 CustomVoice 时将模式改为 `custom` 并提供 `MEDIA_WORKER_MLX_AUDIO_VOICE`。

客户端同时设置 `XHS_MEDIA_WORKER_URL=http://127.0.0.1:8765` 和 `XHS_MEDIA_ROOTS=/tmp/cloud-worker-media`。该 wrapper 只接受 `tts`，输出受控目录内的 `file://` WAV，并明确返回 `simulated:false`、`modelVersion: system-tts-baseline` 和 `reviewRequired:true`；M5 真实声音克隆仍需独立模型、权重、许可证/声音授权和 A/B 金样。

如果 wrapper 返回本地文件，Node 客户端也要把同一目录加入 `XHS_MEDIA_ROOTS`，例如 `XHS_MEDIA_ROOTS=/srv/cloud-worker/media XHS_MEDIA_WORKER_URL=http://127.0.0.1:8765 npm start`；Worker 和客户端只共享受控输出目录，不共享任意路径。

worker 不读取任意绝对路径。没有真实 wrapper、模型权重和授权证据时，继续使用 fake adapter；fake 输出永远带 `simulated: true`，不代表 CosyVoice、OpenVoice 或 MuseTalk 已运行。

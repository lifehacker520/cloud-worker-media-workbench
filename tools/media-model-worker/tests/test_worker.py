import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_DIR))

from adapters.command import CommandAdapter  # noqa: E402
from adapters.fake import FakeAdapter  # noqa: E402
from app import create_server  # noqa: E402
from contracts import ContractError, validate_generation_request  # noqa: E402


class WorkerContractTests(unittest.TestCase):
    def test_rejects_uncontrolled_absolute_file_reference(self):
        with self.assertRaisesRegex(ContractError, "受控任务目录"):
            validate_generation_request(
                {
                    "protocol": "content-media-worker-v1",
                    "idempotencyKey": "key",
                    "input": {"canonicalImageRef": "file:///etc/passwd"},
                },
                allowed_root=WORKER_DIR / "fixtures",
            )

    def test_recursively_validates_nested_media_references(self):
        with self.assertRaisesRegex(ContractError, "受控任务目录"):
            validate_generation_request(
                {
                    "protocol": "content-media-worker-v1",
                    "idempotencyKey": "key",
                    "input": {"avatar": {"canonicalImageRef": "file:///etc/passwd"}},
                },
                allowed_root=WORKER_DIR / "fixtures",
            )
        validate_generation_request(
            {
                "protocol": "content-media-worker-v1",
                "idempotencyKey": "key",
                "input": {
                    "avatar": {
                        "canonicalImageRef": "fixture://avatar.png",
                        "authorizationRef": "consent://avatar",
                    }
                },
            },
            allowed_root=WORKER_DIR / "fixtures",
        )

    def test_keeps_license_reference_as_audit_metadata_not_media_path(self):
        validate_generation_request(
            {
                "protocol": "content-media-worker-v1",
                "idempotencyKey": "voice-license",
                "input": {
                    "voice": {
                        "referenceAudioRef": "fixture://voice.wav",
                        "licenseRef": "license://cosyvoice-3",
                        "authorizationRef": "consent://voice",
                    }
                },
            },
            allowed_root=WORKER_DIR / "fixtures",
        )

    def test_fake_adapter_is_deterministic_and_explicitly_simulated(self):
        adapter = FakeAdapter()
        request = {
            "protocol": "content-media-worker-v1",
            "idempotencyKey": "avatar|voice|script|template|worker",
            "batchId": "batch-test",
            "taskId": "task-test",
            "input": {"avatarVersionId": "avatar-v1", "voiceVersionId": "voice-v1"},
        }
        first = adapter.generate(request)
        second = adapter.generate(request)
        self.assertEqual(first, second)
        self.assertTrue(first["output"]["simulated"])
        self.assertTrue(first["output"]["videoRef"].startswith("simulation://"))
        self.assertFalse(adapter.health()["accelerator"]["available"])

    def test_command_adapter_runs_a_configured_tts_wrapper_without_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            wrapper = Path(directory) / "wrapper.py"
            wrapper.write_text(
                "import json, sys\n"
                "request = json.load(sys.stdin)\n"
                "json.dump({'protocol': 'content-media-worker-v1', 'output': {'outputKind': 'audio', 'audioRef': 'fixture://generated.wav', 'modelVersion': request['input']['modelVersion']}}, sys.stdout)\n",
                encoding="utf-8",
            )
            adapter = CommandAdapter(
                tts_command=[sys.executable, str(wrapper)],
                tts_model="wrapper-tts-v1",
                allowed_root=Path(directory),
            )
            request = {
                "protocol": "content-media-worker-v1",
                "operation": "tts",
                "idempotencyKey": "tts-key",
                "input": {"scriptText": "测试语音", "modelVersion": "wrapper-tts-v1"},
            }
            result = adapter.generate(request)
            self.assertEqual(result["output"]["audioRef"], "fixture://generated.wav")
            self.assertEqual(result["output"]["modelVersion"], "wrapper-tts-v1")
            self.assertEqual(adapter.health()["status"], "ready")
            self.assertEqual(adapter.health()["capabilities"], ["tts"])

    def test_command_adapter_orchestrates_batch_tts_then_talking_head(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tts_wrapper = root / "tts.py"
            tts_wrapper.write_text(
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "request = json.load(sys.stdin)\n"
                "assert request['operation'] == 'tts'\n"
                f"audio = Path({str(root)!r}) / 'generated.wav'\n"
                "audio.write_bytes(b'RIFF' + b'\\x00' * 2048)\n"
                "json.dump({'protocol': 'content-media-worker-v1', 'requestId': 'tts-stage-1', 'output': {'outputKind': 'audio', 'audioRef': audio.as_uri(), 'modelVersion': 'tts-v1', 'simulated': False}}, sys.stdout)\n",
                encoding="utf-8",
            )
            avatar_wrapper = root / "avatar.py"
            avatar_wrapper.write_text(
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "request = json.load(sys.stdin)\n"
                "assert request['operation'] == 'talking_head'\n"
                "assert request['input']['audioRef'].startswith('file:')\n"
                f"video = Path({str(root)!r}) / 'generated.mp4'\n"
                "video.write_bytes(b'\\x00\\x00\\x00\\x18ftypmp42' + b'\\x00' * 2048)\n"
                "json.dump({'protocol': 'content-media-worker-v1', 'requestId': 'avatar-stage-1', 'output': {'outputKind': 'video', 'videoRef': video.as_uri(), 'modelVersion': 'avatar-v1', 'simulated': False}}, sys.stdout)\n",
                encoding="utf-8",
            )
            adapter = CommandAdapter(
                tts_command=[sys.executable, str(tts_wrapper)],
                avatar_command=[sys.executable, str(avatar_wrapper)],
                tts_model="tts-v1",
                avatar_model="avatar-v1",
                allowed_root=root,
            )
            request = {
                "protocol": "content-media-worker-v1",
                "operation": "batch_media",
                "idempotencyKey": "batch-pipeline-key",
                "input": {
                    "scriptText": "批量编排测试。",
                    "voice": {"referenceAudioRef": "fixture://voice.wav"},
                    "avatar": {"baseVideoRef": "fixture://avatar.mp4"},
                },
            }
            result = adapter.generate(request)
            output = result["output"]
            self.assertEqual(output["videoRef"], (root / "generated.mp4").as_uri())
            self.assertEqual(output["audioRef"], (root / "generated.wav").as_uri())
            self.assertEqual(output["pipeline"], ["tts", "talking_head"])
            self.assertEqual(output["ttsRequestId"], "tts-stage-1")
            self.assertEqual(result["requestId"], "avatar-stage-1")
            self.assertFalse(output["simulated"])

    def test_rejects_unknown_generation_operation(self):
        with self.assertRaisesRegex(ContractError, "操作类型不合法"):
            validate_generation_request(
                {
                    "protocol": "content-media-worker-v1",
                    "operation": "arbitrary_command",
                    "idempotencyKey": "key",
                    "input": {},
                },
                allowed_root=WORKER_DIR / "fixtures",
            )

    def test_fake_adapter_returns_the_reference_required_by_each_operation(self):
        adapter = FakeAdapter()
        common = {
            "protocol": "content-media-worker-v1",
            "idempotencyKey": "operation-key",
            "input": {"voiceVersionId": "voice-v1"},
        }
        audio = adapter.generate({**common, "operation": "tts"})["output"]
        video = adapter.generate({**common, "operation": "talking_head"})["output"]
        self.assertTrue(audio["audioRef"].startswith("simulation://"))
        self.assertNotIn("videoRef", audio)
        self.assertTrue(video["videoRef"].startswith("simulation://"))

    def test_server_selects_command_adapter_from_worker_mode(self):
        with patch.dict(os.environ, {
            "MEDIA_WORKER_MODE": "command",
            "MEDIA_WORKER_TTS_COMMAND": f"{sys.executable} -c 'pass'",
            "MEDIA_WORKER_AVATAR_COMMAND": "",
        }, clear=False):
            server = create_server(port=0)
            try:
                self.assertIsInstance(server.adapter, CommandAdapter)
            finally:
                server.server_close()

    @unittest.skipUnless(
        sys.platform == "darwin" and shutil.which("say") and shutil.which("ffmpeg"),
        "macOS say/ffmpeg baseline is unavailable",
    )
    def test_macos_say_wrapper_writes_a_real_audio_file(self):
        wrapper = WORKER_DIR / "wrappers" / "macos_say_tts.py"
        with tempfile.TemporaryDirectory() as directory:
            request = {
                "protocol": "content-media-worker-v1",
                "operation": "tts",
                "idempotencyKey": "macos-say-test",
                "input": {
                    "scriptText": "这是本地真实音频基线测试。",
                    "language": "zh-CN",
                    "modelVersion": "system-tts-baseline",
                },
            }
            result = subprocess.run(
                [sys.executable, str(wrapper)],
                input=json.dumps(request, ensure_ascii=False),
                text=True,
                capture_output=True,
                check=True,
                env={**os.environ, "MEDIA_WORKER_DATA_DIR": directory},
            )
            payload = json.loads(result.stdout)
            output = payload["output"]
            self.assertEqual(payload["protocol"], "content-media-worker-v1")
            self.assertEqual(output["outputKind"], "audio")
            self.assertFalse(output["simulated"])
            audio_path = Path(urlparse(output["audioRef"]).path)
            self.assertTrue(audio_path.is_file())
            self.assertGreater(audio_path.stat().st_size, 1_000)

    @unittest.skipUnless(sys.platform == "darwin", "MLX wrapper is intended for Apple Silicon macOS")
    def test_mlx_audio_wrapper_runs_a_clone_command_and_reuses_the_same_output(self):
        wrapper = WORKER_DIR / "wrappers" / "mlx_audio_tts.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "reference.wav"
            reference.write_bytes(b"reference")
            command = root / "mlx_stub.py"
            command.write_text(
                "import json, sys, wave\n"
                "from pathlib import Path\n"
                "args = sys.argv[1:]\n"
                "out = Path(args[args.index('--output_path') + 1])\n"
                "out.mkdir(parents=True, exist_ok=True)\n"
                "(out / 'argv.json').write_text(json.dumps(args), encoding='utf-8')\n"
                "with wave.open(str(out / 'audio.wav'), 'wb') as stream:\n"
                "    stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(24000); stream.writeframes(b'\\x00\\x00' * 24000)\n",
                encoding="utf-8",
            )
            request = {
                "protocol": "content-media-worker-v1",
                "operation": "tts",
                "idempotencyKey": "mlx-clone-test",
                "input": {
                    "scriptText": "这是 MLX 声音克隆测试。",
                    "language": "zh-CN",
                    "voice": {
                        "referenceAudioRef": reference.as_uri(),
                        "referenceTranscript": "这是参考音频。",
                    },
                },
            }
            env = {
                **os.environ,
                "MEDIA_WORKER_DATA_DIR": directory,
                "MEDIA_WORKER_MLX_AUDIO_COMMAND": f"{sys.executable} {command}",
                "MEDIA_WORKER_MLX_AUDIO_MODEL": "mlx-test-model",
                "MEDIA_WORKER_MLX_AUDIO_MODE": "clone",
            }
            first = subprocess.run(
                [sys.executable, str(wrapper)],
                input=json.dumps(request, ensure_ascii=False),
                text=True,
                capture_output=True,
                check=True,
                env=env,
            )
            second = subprocess.run(
                [sys.executable, str(wrapper)],
                input=json.dumps(request, ensure_ascii=False),
                text=True,
                capture_output=True,
                check=True,
                env=env,
            )
            first_payload = json.loads(first.stdout)
            second_payload = json.loads(second.stdout)
            self.assertEqual(first_payload, second_payload)
            output = first_payload["output"]
            self.assertFalse(output["simulated"])
            self.assertEqual(output["modelVersion"], "mlx-test-model")
            audio_path = Path(urlparse(output["audioRef"]).path)
            self.assertTrue(audio_path.is_file())
            self.assertGreater(audio_path.stat().st_size, 1_000)
            argv = json.loads((audio_path.parent / "argv.json").read_text(encoding="utf-8"))
            self.assertIn("--ref_audio", argv)
            self.assertIn(str(reference.resolve()), argv)
            self.assertIn("--ref_text", argv)
            self.assertIn("--join_audio", argv)

    def test_musetalk_wrapper_builds_a_controlled_inference_request_and_reuses_video(self):
        wrapper = WORKER_DIR / "wrappers" / "musetalk_talking_head.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_root = root / "musetalk-runtime"
            model_root.mkdir()
            (model_root / "unet.pth").write_bytes(b"weights")
            (model_root / "musetalk.json").write_text("{}", encoding="utf-8")
            whisper_dir = model_root / "whisper"
            whisper_dir.mkdir()
            (root / "reference.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 2048)
            (root / "reference.png").write_bytes(b"png")
            (root / "voice.wav").write_bytes(b"RIFF" + b"\x00" * 2048)
            command = root / "musetalk_stub.py"
            command.write_text(
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "args = sys.argv[1:]\n"
                "config = Path(args[args.index('--inference_config') + 1]).read_text(encoding='utf-8')\n"
                "assert 'reference.mp4' in config and 'voice.wav' in config\n"
                "count_path = Path(os.environ['MUSETALK_STUB_COUNT'])\n"
                "count = int(count_path.read_text() or '0') if count_path.exists() else 0\n"
                "count_path.write_text(str(count + 1))\n"
                "out = Path(args[args.index('--result_dir') + 1]) / args[args.index('--version') + 1]\n"
                "out.mkdir(parents=True, exist_ok=True)\n"
                "(out / 'talking_head.mp4').write_bytes(b'\\x00\\x00\\x00\\x18ftypmp42' + b'\\x00' * 2048)\n",
                encoding="utf-8",
            )
            request = {
                "protocol": "content-media-worker-v1",
                "operation": "talking_head",
                "idempotencyKey": "musetalk-video-test",
                "input": {
                    "scriptText": "这是单条数字人视频测试。",
                    "language": "zh-CN",
                    "audioRef": (root / "voice.wav").as_uri(),
                    "voice": {"authorizationRef": "consent://voice"},
                    "avatar": {
                        "baseVideoRef": (root / "reference.mp4").as_uri(),
                        "canonicalImageRef": (root / "reference.png").as_uri(),
                        "authorizationRef": "consent://avatar",
                    },
                },
            }
            env = {
                **os.environ,
                "MEDIA_WORKER_DATA_DIR": directory,
                "MEDIA_WORKER_MUSETALK_COMMAND": f"{sys.executable} {command}",
                "MEDIA_WORKER_MUSETALK_ROOT": str(model_root),
                "MEDIA_WORKER_MUSETALK_UNET_MODEL_PATH": str(model_root / "unet.pth"),
                "MEDIA_WORKER_MUSETALK_UNET_CONFIG": str(model_root / "musetalk.json"),
                "MEDIA_WORKER_MUSETALK_WHISPER_DIR": str(whisper_dir),
                "MEDIA_WORKER_MUSETALK_MODEL_VERSION": "musetalk-1.5",
                "MEDIA_WORKER_MUSETALK_VERSION": "v15",
                "MEDIA_WORKER_MUSETALK_WEIGHTS_HASH": "sha256:test-weights",
                "MEDIA_WORKER_MUSETALK_LICENSE_REF": "license://musetalk-1.5",
                "MUSETALK_STUB_COUNT": str(root / "stub-count"),
            }
            first = subprocess.run(
                [sys.executable, str(wrapper)],
                input=json.dumps(request, ensure_ascii=False),
                text=True,
                capture_output=True,
                check=True,
                env=env,
            )
            second = subprocess.run(
                [sys.executable, str(wrapper)],
                input=json.dumps(request, ensure_ascii=False),
                text=True,
                capture_output=True,
                check=True,
                env=env,
            )
            first_payload = json.loads(first.stdout)
            second_payload = json.loads(second.stdout)
            self.assertEqual(first_payload, second_payload)
            batch = subprocess.run(
                [sys.executable, str(wrapper)],
                input=json.dumps({**request, "operation": "batch_media"}, ensure_ascii=False),
                text=True,
                capture_output=True,
                check=True,
                env=env,
            )
            self.assertEqual(json.loads(batch.stdout), first_payload)
            output = first_payload["output"]
            self.assertEqual(output["outputKind"], "video")
            self.assertFalse(output["simulated"])
            self.assertEqual(output["modelVersion"], "musetalk-1.5")
            self.assertEqual(output["weightsHash"], "sha256:test-weights")
            self.assertEqual(output["licenseRef"], "license://musetalk-1.5")
            video_path = Path(urlparse(output["videoRef"]).path)
            self.assertTrue(video_path.is_file())
            self.assertGreater(video_path.stat().st_size, 1_000)
            self.assertEqual((root / "stub-count").read_text(), "1")


if __name__ == "__main__":
    unittest.main()

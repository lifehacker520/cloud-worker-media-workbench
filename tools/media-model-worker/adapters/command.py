"""Run an explicitly configured model wrapper without invoking a shell."""

import hashlib
import json
import os
import shlex
import shutil
import subprocess

from contracts import PROTOCOL, ContractError, validate_generation_request, validate_reference
from adapters.fake import AdapterError


OPERATIONS = {"batch_media", "tts", "talking_head"}


def _command(value):
    if isinstance(value, (list, tuple)):
        parts = [str(item) for item in value if str(item).strip()]
    elif isinstance(value, str):
        parts = shlex.split(value)
    else:
        parts = []
    return parts or None


def _available(parts):
    if not parts:
        return False
    executable = parts[0]
    return os.path.isfile(executable) and os.access(executable, os.X_OK) if os.path.isabs(executable) else shutil.which(executable) is not None


class CommandAdapter:
    """Bridge a real TTS/avatar wrapper that accepts JSON on stdin and returns JSON."""

    def __init__(self, tts_command=None, avatar_command=None, tts_model="configured-tts", avatar_model="configured-avatar", allowed_root=None, timeout_seconds=300):
        self.tts_command = _command(tts_command)
        self.avatar_command = _command(avatar_command)
        self.tts_model = str(tts_model or "configured-tts")
        self.avatar_model = str(avatar_model or "configured-avatar")
        self.allowed_root = allowed_root
        self.timeout_seconds = max(1, int(timeout_seconds))

    def health(self):
        capabilities = []
        models = {}
        unavailable = []
        if self.tts_command:
            if _available(self.tts_command):
                capabilities.append("tts")
                models["tts"] = self.tts_model
            else:
                unavailable.append("tts")
        if self.avatar_command:
            if _available(self.avatar_command):
                capabilities.append("talking_head")
                models["avatar"] = self.avatar_model
            else:
                unavailable.append("talking_head")
        partial = bool(capabilities and unavailable)
        return {
            "protocol": PROTOCOL,
            "status": "ready" if capabilities else "unavailable",
            "reason": "capability_partial" if partial else None if capabilities else ("model_command_unavailable" if unavailable else "model_command_not_configured"),
            "workerVersion": "command-worker-v1",
            "accelerator": {"type": os.environ.get("MEDIA_WORKER_ACCELERATOR", "external"), "available": True},
            "models": models,
            "capabilities": capabilities,
            "missingCapabilities": unavailable,
            "partial": partial,
            "simulation": False,
            "weights": [],
        }

    def _selection(self, operation):
        if operation == "tts":
            return self.tts_command, self.tts_model, "audioRef", "tts"
        return self.avatar_command, self.avatar_model, "videoRef", "talking_head"

    def _run(self, request, operation):
        command, model, required_ref, capability = self._selection(operation)
        if not command or not _available(command):
            raise AdapterError("模型命令未配置或不可执行", "MODEL_COMMAND_NOT_CONFIGURED", 503, False)
        request = {**request, "input": {**request.get("input", {}), "modelVersion": request.get("input", {}).get("modelVersion", model)}}
        encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
        try:
            completed = subprocess.run(
                command,
                input=encoded,
                text=True,
                capture_output=True,
                timeout=self.timeout_seconds,
                check=False,
                shell=False,
            )
        except subprocess.TimeoutExpired as error:
            raise AdapterError("模型命令执行超时", "MODEL_COMMAND_TIMEOUT", 504, True) from error
        except OSError as error:
            raise AdapterError("模型命令无法启动", "MODEL_COMMAND_START_FAILED", 503, False) from error
        if completed.returncode != 0:
            raise AdapterError("模型命令执行失败", "MODEL_COMMAND_FAILED", 502, True)
        try:
            payload = json.loads(completed.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise AdapterError("模型命令返回了无效 JSON", "MODEL_COMMAND_INVALID_JSON", 502, False) from error
        if not isinstance(payload, dict) or (payload.get("protocol") and payload["protocol"] != PROTOCOL):
            raise AdapterError("模型命令协议版本不匹配", "MEDIA_WORKER_PROTOCOL_MISMATCH", 502, False)
        output = payload.get("output")
        if not isinstance(output, dict) or not isinstance(output.get(required_ref), str) or not output[required_ref].strip():
            raise AdapterError("模型命令未返回所需媒体引用", "MODEL_COMMAND_OUTPUT_MISSING", 502, False)
        for key in ("audioRef", "videoRef"):
            if key in output and output[key] is not None:
                try:
                    validate_reference(output[key], self.allowed_root)
                except ContractError as error:
                    raise AdapterError("模型命令返回了越界媒体引用", "MODEL_COMMAND_OUTPUT_PATH_INVALID", 502, False) from error
        digest = hashlib.sha256(str(request.get("idempotencyKey", "")).encode("utf-8")).hexdigest()[:24]
        return {
            "protocol": PROTOCOL,
            "requestId": payload.get("requestId") or "command-request-" + digest,
            "taskId": payload.get("taskId") or "command-task-" + digest,
            "output": {
                **output,
                "modelVersion": output.get("modelVersion") or model,
                "simulation": False,
                "simulated": False,
                "reviewRequired": output.get("reviewRequired") is not False,
                "capability": capability,
            },
        }

    def generate(self, request):
        validate_generation_request(request, self.allowed_root)
        operation = request.get("operation", "batch_media")
        if operation not in OPERATIONS:
            raise ContractError("媒体 worker 操作类型不合法", "MEDIA_WORKER_OPERATION_INVALID")
        if operation != "batch_media":
            return self._run(request, operation)

        tts = self._run({**request, "operation": "tts"}, "tts")
        talking_head = self._run({
            **request,
            "operation": "talking_head",
            "input": {
                **request.get("input", {}),
                "audioRef": tts["output"]["audioRef"],
            },
        }, "talking_head")
        return {
            "protocol": PROTOCOL,
            "requestId": talking_head["requestId"],
            "taskId": talking_head["taskId"],
            "output": {
                **talking_head["output"],
                "audioRef": tts["output"]["audioRef"],
                "pipeline": ["tts", "talking_head"],
                "ttsRequestId": tts["requestId"],
                "ttsModelVersion": tts["output"]["modelVersion"],
                "talkingHeadRequestId": talking_head["requestId"],
            },
        }

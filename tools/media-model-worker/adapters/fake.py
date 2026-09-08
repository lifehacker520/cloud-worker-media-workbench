import hashlib
import json

from contracts import PROTOCOL, ContractError, validate_generation_request


class AdapterError(RuntimeError):
    def __init__(self, message, code="MEDIA_WORKER_UNAVAILABLE", status=503, retryable=True):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


class FakeAdapter:
    """A deterministic adapter for protocol and queue testing only."""

    def __init__(self, mode="fake", allowed_root=None):
        self.mode = mode
        self.allowed_root = allowed_root

    def health(self):
        if self.mode == "unavailable":
            return {
                "protocol": PROTOCOL,
                "status": "unavailable",
                "reason": "fake_worker_disabled",
                "accelerator": {"type": "none", "available": False, "reason": "no_gpu_configured"},
                "models": {},
                "capabilities": ["tts", "talking_head"],
                "simulation": True,
            }
        return {
            "protocol": PROTOCOL,
            "status": "ready",
            "workerVersion": "fake-worker-v1",
            "accelerator": {"type": "none", "available": False, "reason": "fake_adapter_only"},
            "models": {"tts": "fake-tts-v1", "avatar": "fake-avatar-v1"},
            "capabilities": ["tts", "talking_head"],
            "simulation": True,
            "weights": [],
        }

    def generate(self, request):
        validate_generation_request(request, self.allowed_root)
        if self.mode == "unavailable":
            raise AdapterError("fake worker 当前不可用")
        digest = hashlib.sha256(request["idempotencyKey"].encode("utf-8")).hexdigest()[:24]
        batch_id = request.get("batchId") or "batch"
        has_voice = bool(request.get("input", {}).get("voiceVersionId"))
        operation = request.get("operation", "batch_media")
        output = {
            "simulated": True,
            "reviewRequired": True,
        }
        if operation == "tts":
            output.update({
                "outputKind": "audio",
                "audioRef": f"simulation://{batch_id}/{digest}.wav",
                "modelVersion": "fake-tts-v1",
            })
        else:
            output.update({
                "outputKind": "video_manifest",
                "videoRef": f"simulation://{batch_id}/{digest}.mp4",
                "audioRef": f"simulation://{batch_id}/{digest}.wav" if has_voice else None,
                "modelVersion": "fake-avatar-v1",
            })
        return {
            "protocol": PROTOCOL,
            "requestId": "fake-request-" + digest,
            "taskId": "fake-task-" + digest,
            "output": output,
        }

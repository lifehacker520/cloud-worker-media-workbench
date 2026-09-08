"""Small, dependency-free contract checks shared by media worker adapters."""

from pathlib import Path
from urllib.parse import unquote, urlparse

PROTOCOL = "content-media-worker-v1"
NON_MEDIA_REFERENCE_KEYS = {"authorizationRef", "authorizationRecordRef", "licenseRef"}
OPERATIONS = {"batch_media", "tts", "talking_head"}


class ContractError(ValueError):
    """An input cannot be accepted by the worker contract."""

    def __init__(self, message, code="MEDIA_WORKER_INVALID_INPUT"):
        super().__init__(message)
        self.code = code


def _safe_file_reference(value, allowed_root):
    if allowed_root is None:
        raise ContractError("文件引用必须位于受控任务目录")
    root = Path(allowed_root).resolve()
    parsed = urlparse(value)
    raw_path = unquote(parsed.path) if parsed.scheme == "file" else value
    candidate = Path(raw_path)
    if candidate.is_absolute() and parsed.scheme != "file":
        raise ContractError("文件引用必须位于受控任务目录")
    resolved = (candidate if candidate.is_absolute() else root / candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ContractError("文件引用必须位于受控任务目录") from error


def validate_reference(value, allowed_root=None):
    if value is None:
        return
    if not isinstance(value, str) or not value.strip():
        raise ContractError("媒体引用必须是非空字符串")
    value = value.strip()
    parsed = urlparse(value)
    if parsed.scheme == "file" or not parsed.scheme:
        _safe_file_reference(value, allowed_root)
    elif parsed.scheme not in {"fixture", "simulation", "https", "http", "s3"}:
        raise ContractError("媒体引用协议不在允许范围内")


def _validate_input_references(value, allowed_root=None, key=None):
    if isinstance(value, dict):
        for nested_key, nested_value in value.items():
            if nested_key in NON_MEDIA_REFERENCE_KEYS:
                continue
            if nested_key.endswith("Ref") or nested_key.endswith("Path") or nested_key in {"file", "path"}:
                if isinstance(nested_value, list):
                    for reference in nested_value:
                        validate_reference(reference, allowed_root)
                else:
                    validate_reference(nested_value, allowed_root)
            else:
                _validate_input_references(nested_value, allowed_root, nested_key)
    elif isinstance(value, list):
        for item in value:
            _validate_input_references(item, allowed_root, key)


def validate_generation_request(payload, allowed_root=None):
    if not isinstance(payload, dict):
        raise ContractError("请求必须是 JSON 对象")
    if payload.get("protocol") != PROTOCOL:
        raise ContractError("媒体 worker 协议版本不匹配", "MEDIA_WORKER_PROTOCOL_MISMATCH")
    if payload.get("operation", "batch_media") not in OPERATIONS:
        raise ContractError("媒体 worker 操作类型不合法", "MEDIA_WORKER_OPERATION_INVALID")
    idempotency_key = payload.get("idempotencyKey")
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 512:
        raise ContractError("请求缺少有效幂等键", "MEDIA_WORKER_IDEMPOTENCY_KEY_INVALID")
    inputs = payload.get("input")
    if not isinstance(inputs, dict):
        raise ContractError("请求缺少 input 对象")
    _validate_input_references(inputs, allowed_root)
    return payload

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from adapters.command import CommandAdapter
from adapters.fake import AdapterError, FakeAdapter
from contracts import ContractError, PROTOCOL, validate_generation_request


class WorkerHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, adapter, allowed_root):
        super().__init__(address, WorkerRequestHandler)
        self.adapter = adapter
        self.allowed_root = allowed_root


class WorkerRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string, *args):
        return

    def _write(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._write(200, self.server.adapter.health())
            return
        self._write(404, {"errorClass": "not_found", "message": "worker endpoint not found"})

    def do_POST(self):
        if self.path != "/v1/media/generate":
            self._write(404, {"errorClass": "not_found", "message": "worker endpoint not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 4 * 1024 * 1024:
                raise ContractError("请求体大小不合法", "MEDIA_WORKER_BODY_SIZE_INVALID")
            payload = json.loads(self.rfile.read(length))
            validate_generation_request(payload, self.server.allowed_root)
            self._write(200, self.server.adapter.generate(payload))
        except ContractError as error:
            self._write(400, {"errorClass": "invalid_input", "code": error.code, "message": str(error), "retryable": False})
        except AdapterError as error:
            self._write(error.status, {"errorClass": "worker_unavailable", "code": error.code, "message": str(error), "retryable": error.retryable})
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._write(400, {"errorClass": "invalid_input", "code": "MEDIA_WORKER_JSON_INVALID", "message": "请求不是合法 JSON", "retryable": False})
        except Exception:
            self._write(500, {"errorClass": "server_error", "code": "MEDIA_WORKER_INTERNAL_ERROR", "message": "媒体 worker 内部错误", "retryable": True})


def create_server(host="127.0.0.1", port=8765, adapter=None, allowed_root=None):
    root = Path(allowed_root or os.environ.get("MEDIA_WORKER_DATA_DIR", Path(__file__).resolve().parent / "data")).resolve()
    if adapter is not None:
        selected = adapter
    elif os.environ.get("MEDIA_WORKER_MODE", "fake") == "command":
        selected = CommandAdapter(
            tts_command=os.environ.get("MEDIA_WORKER_TTS_COMMAND"),
            avatar_command=os.environ.get("MEDIA_WORKER_AVATAR_COMMAND"),
            tts_model=os.environ.get("MEDIA_WORKER_TTS_MODEL", "configured-tts"),
            avatar_model=os.environ.get("MEDIA_WORKER_AVATAR_MODEL", "configured-avatar"),
            allowed_root=root,
            timeout_seconds=int(os.environ.get("MEDIA_WORKER_COMMAND_TIMEOUT_SECONDS", "300")),
        )
    else:
        selected = FakeAdapter(os.environ.get("MEDIA_WORKER_MODE", "fake"), root)
    return WorkerHTTPServer((host, port), selected, root)


def main():
    parser = argparse.ArgumentParser(description="Cloud Worker media model protocol worker")
    parser.add_argument("--host", default=os.environ.get("MEDIA_WORKER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MEDIA_WORKER_PORT", "8765")))
    args = parser.parse_args()
    server = create_server(args.host, args.port)
    print(f"media worker listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

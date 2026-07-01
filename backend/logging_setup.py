"""
Structured logging + request correlation.

Two opt-in-friendly pieces:

* `configure_logging()` installs a single stdout handler on the root logger.
  Format is **human-readable text by default** (desktop / dev output is
  unchanged) and switches to **one JSON object per line** when `LOG_FORMAT=json`
  — the shape log shippers (Loki, CloudWatch, Datadog) want. `LOG_LEVEL`
  (default INFO) tunes verbosity.

* `RequestContextMiddleware` assigns each HTTP request a short id (honouring an
  inbound `X-Request-ID`, else generating one), echoes it back in the response
  header, and stamps it onto every log line emitted while that request runs — so
  a request can be traced end-to-end. It also emits one access line per request
  with method / path / status / duration.

Pure-stdlib (no new dependencies), and a complete no-op for behaviour: nothing
here changes responses beyond adding the correlation header.
"""
import json
import logging
import os
import sys
import time
import uuid
from contextvars import ContextVar

# Correlation id for the in-flight request; "-" outside any request.
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

# Attributes already on a LogRecord — anything else a caller passes via
# `extra={...}` is treated as a structured field and merged into JSON output.
_RESERVED = set(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys()
) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
                  + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        for k, v in record.__dict__.items():
            if k not in _RESERVED and not k.startswith("_"):
                out[k] = v
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        rid = request_id_var.get()
        tag = f"[{rid[:8]}] " if rid and rid != "-" else ""
        base = (f"{self.formatTime(record, '%H:%M:%S')} {record.levelname:<5} "
                f"{tag}{record.name}: {record.getMessage()}")
        if record.exc_info:
            base += "\n" + self.formatException(record.exc_info)
        return base


_configured = False


def configure_logging() -> None:
    """Idempotently install the root stdout handler. Safe to call at import."""
    global _configured
    if _configured:
        return
    fmt = os.environ.get("LOG_FORMAT", "text").strip().lower()
    level = os.environ.get("LOG_LEVEL", "INFO").strip().upper()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if fmt == "json" else TextFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, level, logging.INFO))
    _configured = True


logger = logging.getLogger("erp.access")


def _new_request_id(inbound: "str | None") -> str:
    return (inbound or uuid.uuid4().hex)[:64]


class RequestContextMiddleware:
    """Pure-ASGI (never buffers bodies, so streaming / file responses are safe)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        inbound = headers.get(b"x-request-id")
        rid = _new_request_id(inbound.decode("latin-1") if inbound else None)
        token = request_id_var.set(rid)
        started = time.perf_counter()
        status = {"code": 0}

        async def _send(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                message.setdefault("headers", []).append(
                    (b"x-request-id", rid.encode("latin-1")))
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            path = scope.get("path", "")
            client = scope.get("client")
            # API traffic at INFO; static-asset noise at DEBUG (hidden by default).
            lvl = logging.INFO if path.startswith("/api") else logging.DEBUG
            logger.log(lvl, "request", extra={
                "method": scope.get("method"),
                "path": path,
                "status": status["code"],
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "client": client[0] if client else None,
            })
            request_id_var.reset(token)

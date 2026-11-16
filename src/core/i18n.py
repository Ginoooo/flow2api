"""Translate public API messages without modifying account or generation data."""

import json
import re
from functools import lru_cache
from pathlib import Path


SUPPORTED_LANGUAGES = ("zh-CN", "en")


def negotiate_language(header: str = "") -> str:
    """Choose a supported language using Accept-Language quality weights."""
    choices = []
    for index, entry in enumerate(header.split(",")):
        parts = entry.strip().split(";")
        language = parts[0].strip().lower()
        quality = 1.0
        for parameter in parts[1:]:
            if parameter.strip().lower().startswith("q="):
                try:
                    quality = float(parameter.strip()[2:])
                except ValueError:
                    quality = 0.0
        if not 0 < quality <= 1:
            continue
        if language == "zh" or language.startswith("zh-"):
            choices.append((quality, -index, "zh-CN"))
        elif language == "en" or language.startswith("en-"):
            choices.append((quality, -index, "en"))
    return max(choices)[2] if choices else "zh-CN"


@lru_cache(maxsize=1)
def _catalog():
    path = Path(__file__).resolve().parents[2] / "static" / "locales" / "backend.json"
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _patterns():
    patterns = []
    for source in _catalog()["zh-CN"]:
        names = []
        parts = []
        position = 0
        for match in re.finditer(r"\{(\w+)\}", source):
            parts.extend((re.escape(source[position : match.start()]), "(.*?)"))
            names.append(match[1])
            position = match.end()
        if names:
            parts.append(re.escape(source[position:]))
            specificity = len(re.sub(r"\{\w+\}", "", source))
            patterns.append(
                (specificity, source, re.compile("".join(parts), re.S), names)
            )
    return sorted(
        patterns, key=lambda entry: (entry[0], "error" in entry[3]), reverse=True
    )


def translate_message(message: str, language: str = "zh-CN", *, _depth: int = 0) -> str:
    """Translate known messages and nested errors, preserving other parameters."""
    if language not in SUPPORTED_LANGUAGES:
        language = "zh-CN"
    catalog = _catalog()[language]
    if message in catalog:
        return catalog[message]
    if len(message) > 8192:
        return message
    for _, source, pattern, names in _patterns():
        match = pattern.fullmatch(message)
        if match:
            params = dict(zip(names, match.groups()))
            if "error" in params and _depth < 4:
                params["error"] = translate_message(
                    params["error"], language, _depth=_depth + 1
                )
            return re.sub(
                r"\{(\w+)\}",
                lambda item: params.get(item[1], item[0]),
                catalog.get(source, source),
            )
    return message


def _translate_payload(payload, language):
    if not isinstance(payload, dict):
        return payload
    for key in ("message", "detail"):
        if isinstance(payload.get(key), str):
            payload[key] = translate_message(payload[key], language)
    # FastAPI validation details contain request input: only translate the message.
    if isinstance(payload.get("detail"), list):
        for item in payload["detail"]:
            if isinstance(item, dict) and isinstance(item.get("msg"), str):
                item["msg"] = translate_message(item["msg"], language)
    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        error["message"] = translate_message(error["message"], language)
    return payload


class I18nMiddleware:
    """Localize JSON message fields while passing streams and log records through."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        is_admin = path.startswith("/api/") and not path.startswith("/api/logs")
        is_generation = path == "/models" or path.startswith(
            ("/v1/", "/v1beta/", "/models/")
        )
        if scope["type"] != "http" or not (is_admin or is_generation):
            await self.app(scope, receive, send)
            return

        request_headers = dict(scope.get("headers", []))
        language = negotiate_language(
            request_headers.get(b"accept-language", b"").decode("latin-1")
        )
        pending_start = None
        chunks = []
        size = 0

        async def localized_send(message):
            nonlocal pending_start, size
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                content_type = next(
                    (
                        value
                        for name, value in headers
                        if name.lower() == b"content-type"
                    ),
                    b"",
                )
                if b"application/json" not in content_type or (
                    not is_admin and message["status"] < 400
                ):
                    await send(message)
                    return
                headers = [
                    (name, value)
                    for name, value in headers
                    if name.lower() != b"content-language"
                ]
                headers.append((b"content-language", language.encode("ascii")))
                vary = next(
                    (value for name, value in headers if name.lower() == b"vary"), b""
                )
                if (
                    b"accept-language"
                    not in {item.strip().lower() for item in vary.split(b",")}
                    and vary != b"*"
                ):
                    headers = [
                        (name, value)
                        for name, value in headers
                        if name.lower() != b"vary"
                    ]
                    headers.append(
                        (b"vary", vary + (b", " if vary else b"") + b"Accept-Language")
                    )
                message = {**message, "headers": headers}
                pending_start = message
                return

            if message["type"] == "http.response.body" and pending_start is not None:
                chunks.append(message.get("body", b""))
                size += len(chunks[-1])
                # Do not buffer large responses or hold up streaming content.
                if size > 1024 * 1024:
                    await send(pending_start)
                    pending_start = None
                    await send({**message, "body": b"".join(chunks)})
                    chunks.clear()
                    return
                if message.get("more_body", False):
                    return
                body = b"".join(chunks)
                try:
                    payload = _translate_payload(json.loads(body), language)
                    body = json.dumps(
                        payload, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")
                except (ValueError, UnicodeDecodeError):
                    pass
                headers = [
                    (name, value)
                    for name, value in pending_start["headers"]
                    if name.lower() != b"content-length"
                ]
                headers.append((b"content-length", str(len(body)).encode("ascii")))
                await send({**pending_start, "headers": headers})
                pending_start = None
                await send({**message, "body": body})
                chunks.clear()
                return
            await send(message)

        await self.app(scope, receive, localized_send)

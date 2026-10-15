"""Browser solver pool adapted from upstream PR #102 (8c2648c)."""

import asyncio
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect


@dataclass
class ClientInfo:
    ws: WebSocket
    client_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    name: str = ""
    source: str = "manual"
    connected_at: float = field(default_factory=time.time)
    enabled: bool = True
    auto_disabled: bool = False
    busy: bool = False
    solve_count: int = 0
    error_count: int = 0
    consecutive_errors: int = 0


class ExtensionCaptchaService:
    _instance: Optional["ExtensionCaptchaService"] = None

    def __init__(self):
        self._auth_key = ""
        self._auth_generation = 0
        self.refresh_interval = 2
        self.max_consecutive_errors = 5
        self._clients: dict[str, ClientInfo] = {}
        self._pending: dict[str, tuple[asyncio.Future, ClientInfo]] = {}
        self._changed = asyncio.Event()
        self._round_robin = 0
        self._waiting = 0
        self.stats = {"total_requests": 0, "success": 0, "errors": 0}

    @classmethod
    def get_instance(cls) -> "ExtensionCaptchaService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def configure(self, auth_key: str, refresh_interval: int = 2,
                        max_consecutive_errors: int = 5):
        if auth_key != self._auth_key:
            self._auth_key = auth_key
            self._auth_generation += 1
            await self.close()
        self.refresh_interval = refresh_interval
        self.max_consecutive_errors = max_consecutive_errors
        for client in list(self._clients.values()):
            try:
                await client.ws.send_json(self._config_message())
            except Exception:
                self._drop_client(client)

    def _config_message(self) -> dict:
        return {"type": "config", "refreshInterval": self.refresh_interval}

    @property
    def has_clients(self) -> bool:
        return any(client.enabled for client in self._clients.values())

    def get_clients_info(self) -> list[dict]:
        return [
            {
                "client_id": client.client_id,
                "name": client.name or "browser",
                "source": client.source,
                "authed": True,
                "enabled": client.enabled,
                "auto_disabled": client.auto_disabled,
                "busy": client.busy,
                "uptime_seconds": int(time.time() - client.connected_at),
                "solve_count": client.solve_count,
                "error_count": client.error_count,
                "consecutive_errors": client.consecutive_errors,
            }
            for client in self._clients.values()
        ]

    def set_client_enabled(self, client_id: str, enabled: bool) -> bool:
        client = self._clients.get(client_id)
        if client is None:
            return False
        client.enabled = enabled
        if enabled:
            client.auto_disabled = False
            client.consecutive_errors = 0
        self._changed.set()
        return True

    def _drop_client(self, client: ClientInfo):
        self._clients.pop(client.client_id, None)
        for future, owner in list(self._pending.values()):
            if owner is client and not future.done():
                future.set_exception(RuntimeError("Browser solver disconnected"))
        self._changed.set()

    async def close(self):
        for client in list(self._clients.values()):
            self._drop_client(client)
            try:
                await client.ws.close(code=1001)
            except Exception:
                pass

    async def handle_websocket(self, websocket: WebSocket):
        if not self._auth_key:
            await websocket.close(code=1008)
            return
        auth_generation = self._auth_generation
        await websocket.accept()
        client = ClientInfo(
            websocket,
            name=(websocket.query_params.get("name") or "")[:80],
            source="manual",
        )
        try:
            auth = await asyncio.wait_for(websocket.receive_json(), timeout=10)
            key = auth.get("key") if isinstance(auth, dict) else None
            if (not isinstance(key, str) or len(key) > 256
                    or auth.get("type") != "auth" or not self._auth_key
                    or auth_generation != self._auth_generation
                    or not secrets.compare_digest(key.encode(), self._auth_key.encode())):
                await websocket.send_json({"type": "auth_fail", "error": "Invalid solver key"})
                await websocket.close(code=1008)
                return
            await websocket.send_json({"type": "auth_ok"})
            await websocket.send_json(self._config_message())
            if auth_generation != self._auth_generation:
                await websocket.close(code=1008)
                return
            self._clients[client.client_id] = client
            self._changed.set()
            while True:
                message = await websocket.receive_json()
                if not isinstance(message, dict):
                    await websocket.close(code=1008)
                    return
                await self._handle_message(client, message)
        except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, RuntimeError, OSError):
            try:
                await websocket.close(code=1008)
            except Exception:
                pass
        finally:
            self._drop_client(client)

    async def _handle_message(self, client: ClientInfo, message: dict):
        if self._clients.get(client.client_id) is not client:
            return
        if message.get("type") == "ping":
            await client.ws.send_json({"type": "pong"})
        elif message.get("type") == "result":
            request_id = message.get("id")
            pending = self._pending.get(request_id) if isinstance(request_id, str) else None
            if pending is None:
                return
            future, owner = pending
            if owner is not client or future.done():
                return
            token = message.get("token")
            if message.get("error") or not isinstance(token, str) or not token.strip():
                future.set_exception(RuntimeError("Browser solver returned no valid token"))
            else:
                future.set_result(token)

    async def get_token(self, action: str = "IMAGE_GENERATION", site_key: str = "",
                        timeout: float = 25, client_id: Optional[str] = None) -> str:
        if not self._auth_key or not self.has_clients and client_id is None:
            raise RuntimeError("No authenticated browser solver available")
        if self._waiting >= 128:
            raise RuntimeError("Browser solver queue is full")
        self._waiting += 1
        deadline = time.monotonic() + timeout
        client = None
        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.stats["total_requests"] += 1
        try:
            async with asyncio.timeout(timeout):
                while client is None:
                    available = [
                        item for item in self._clients.values()
                        if (item.client_id == client_id if client_id else item.enabled)
                    ]
                    if not available:
                        raise RuntimeError("No authenticated browser solver available")
                    idle = [item for item in available if not item.busy]
                    if idle:
                        client = idle[self._round_robin % len(idle)]
                        self._round_robin += 1
                        client.busy = True
                    else:
                        self._changed.clear()
                        await self._changed.wait()
                self._pending[request_id] = (future, client)
                await client.ws.send_json({
                    "type": "solve", "id": request_id, "action": action,
                    "siteKey": site_key,
                    "timeoutMs": max(1, int((deadline - time.monotonic()) * 1000)),
                })
                token = await future
                client.solve_count += 1
                client.consecutive_errors = 0
                self.stats["success"] += 1
                return token
        except Exception:
            self.stats["errors"] += 1
            if client is not None:
                client.error_count += 1
                client.consecutive_errors += 1
                if (self.max_consecutive_errors
                        and client.consecutive_errors >= self.max_consecutive_errors):
                    client.enabled = False
                    client.auto_disabled = True
            raise
        finally:
            self._waiting -= 1
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()
            if client is not None:
                client.busy = False
            self._changed.set()

    async def test_client(self, client_id: str, site_key: str) -> dict:
        started = time.monotonic()
        try:
            token = await self.get_token(site_key=site_key, client_id=client_id)
            return {"success": True, "token_length": len(token),
                    "elapsed_ms": int((time.monotonic() - started) * 1000)}
        except Exception:
            return {"success": False, "error": "Solver test failed; check connection and Flow login"}
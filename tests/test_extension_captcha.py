import asyncio
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi import WebSocketDisconnect

from src.services.extension_captcha import ExtensionCaptchaService


class SolverSocket:
    def __init__(self):
        self.query_params = {}
        self.messages = asyncio.Queue()
        self.sent = asyncio.Queue()
        self.accept = AsyncMock()
        self.close = AsyncMock()

    async def receive_json(self):
        message = await self.messages.get()
        if isinstance(message, Exception):
            raise message
        return message

    async def send_json(self, message):
        await self.sent.put(message)


class ExtensionServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.service = ExtensionCaptchaService()
        await self.service.configure("fixture-key")

    async def connect(self):
        socket = SolverSocket()
        await socket.messages.put({"type": "auth", "key": "fixture-key"})
        task = asyncio.create_task(self.service.handle_websocket(socket))
        self.assertEqual((await socket.sent.get())["type"], "auth_ok")
        self.assertEqual((await socket.sent.get())["type"], "config")
        self.addAsyncCleanup(self.disconnect, socket, task)
        return socket

    async def disconnect(self, socket, task):
        await socket.messages.put(WebSocketDisconnect())
        await task

    async def test_empty_and_wrong_keys_cannot_join_pool(self):
        for key in ("", "wrong-key"):
            socket = SolverSocket()
            if not key:
                await self.service.configure("")
            await socket.messages.put({"type": "auth", "key": key})
            await self.service.handle_websocket(socket)
            self.assertFalse(self.service.has_clients)
            socket.close.assert_awaited()
            await self.service.configure("fixture-key")

    async def test_only_owner_can_return_nonempty_token(self):
        owner = await self.connect()
        other = await self.connect()
        task = asyncio.create_task(self.service.get_token("UPLOAD_IMAGE", "site-key"))
        request = await owner.sent.get()
        self.assertEqual(request["action"], "UPLOAD_IMAGE")
        self.assertEqual(request["siteKey"], "site-key")
        await self.service._handle_message(
            next(item for item in self.service._clients.values() if item.ws is other),
            {"type": "result", "id": request["id"], "token": "wrong-owner"},
        )
        self.assertFalse(task.done())
        await owner.messages.put({"type": "result", "id": request["id"], "token": "token"})
        self.assertEqual(await task, "token")
        self.assertFalse(self.service._pending)

    async def test_empty_token_disables_and_manual_enable_recovers(self):
        self.service.max_consecutive_errors = 1
        socket = await self.connect()
        task = asyncio.create_task(self.service.get_token(site_key="key"))
        request = await socket.sent.get()
        await socket.messages.put({"type": "result", "id": request["id"], "token": ""})
        with self.assertRaises(RuntimeError):
            await task
        info = self.service.get_clients_info()[0]
        self.assertTrue(info["auto_disabled"])
        self.assertFalse(self.service.has_clients)
        self.service.set_client_enabled(info["client_id"], True)
        self.assertTrue(self.service.has_clients)

    async def test_disconnect_and_timeout_clear_owned_pending(self):
        socket = await self.connect()
        task = asyncio.create_task(self.service.get_token(timeout=1))
        await socket.sent.get()
        await socket.messages.put(WebSocketDisconnect())
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            await task
        self.assertFalse(self.service._pending)
        socket = await self.connect()
        with self.assertRaises(TimeoutError):
            await self.service.get_token(timeout=0.01)
        self.assertFalse(self.service._pending)

    async def test_single_client_serializes_and_cancellation_releases_slot(self):
        socket = await self.connect()
        first = asyncio.create_task(self.service.get_token())
        await socket.sent.get()
        second = asyncio.create_task(self.service.get_token())
        await asyncio.sleep(0)
        self.assertTrue(socket.sent.empty())
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        request = await socket.sent.get()
        await socket.messages.put({"type": "result", "id": request["id"], "token": "next"})
        self.assertEqual(await second, "next")
        self.assertFalse(self.service._pending)

    async def test_key_rotation_rejects_in_progress_old_handshake(self):
        socket = SolverSocket()
        sent_config = asyncio.Event()
        resume = asyncio.Event()
        send_json = socket.send_json

        async def pause_after_config(message):
            await send_json(message)
            if message["type"] == "config":
                sent_config.set()
                await resume.wait()

        socket.send_json = pause_after_config
        await socket.messages.put({"type": "auth", "key": "fixture-key"})
        task = asyncio.create_task(self.service.handle_websocket(socket))
        await sent_config.wait()
        await self.service.configure("replacement-key")
        resume.set()
        await task
        self.assertFalse(self.service.has_clients)
        socket.close.assert_awaited()

    async def test_key_rotation_disconnects_pending_requests(self):
        socket = await self.connect()
        task = asyncio.create_task(self.service.get_token())
        await socket.sent.get()
        await self.service.configure("replacement-key")
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            await task
        self.assertFalse(self.service._pending)
        self.assertFalse(self.service.has_clients)

    async def test_legacy_account_routes_remain_isolated(self):
        from src.services.browser_captcha_extension import (
            ExtensionCaptchaService as LegacyService, ExtensionConnection,
        )
        legacy = LegacyService()
        legacy.active_connections.append(ExtensionConnection(SolverSocket(), route_key="account-a"))
        self.assertIsNone(legacy._select_connection("account-b"))
        self.assertIsNone(legacy._select_connection(""))


class ExtensionConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_schema_migration_is_idempotent(self):
        import tempfile
        from src.core.database import Database

        with tempfile.TemporaryDirectory() as directory:
            database = Database(directory + "/flow.db")
            await database.init_db()
            async with database._connect(write=True) as connection:
                await connection.execute("DROP TABLE captcha_config")
                await connection.execute("CREATE TABLE captcha_config (id INTEGER PRIMARY KEY, captcha_method TEXT, yescaptcha_api_key TEXT)")
                await connection.execute("INSERT INTO captcha_config VALUES (1, 'personal', 'existing-key')")
                await connection.commit()
            await database.check_and_migrate_db()
            await database.check_and_migrate_db()
            cfg = await database.get_captcha_config()
            self.assertEqual(cfg.captcha_method, "personal")
            self.assertEqual(cfg.yescaptcha_api_key, "existing-key")
            self.assertEqual(cfg.extension_auth_key, "")
            self.assertEqual(cfg.extension_refresh_interval, 2)

    async def test_management_script_is_served_by_actual_application(self):
        import httpx
        from src.main import app

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            response = await client.get("/static/extension-captcha.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("extension-status", response.text)
        self.assertIn("javascript", response.headers["content-type"])

    async def test_persistence_partial_update_migration_and_hot_reload(self):
        import copy
        import tempfile
        from src.core.config import config
        from src.core.database import Database

        saved = copy.deepcopy(config.get_raw_config())
        self.addCleanup(setattr, config, "_config", saved)
        with tempfile.TemporaryDirectory() as directory:
            database = Database(directory + "/flow.db")
            await database.init_db()
            await database.init_config_from_toml({"captcha": {
                "extension_auth_key": "initial-key", "extension_refresh_interval": 3,
            }})
            await database.update_captcha_config(
                captcha_method="personal", yescaptcha_api_key="old-key",
                extension_auth_key="fixture-key", extension_refresh_interval=4,
            )
            await database.update_captcha_config(browser_count=2)
            await database.check_and_migrate_db()
            await database.check_and_migrate_db()
            await database.reload_config_to_memory()
            restarted = await Database(database.db_path).get_captcha_config()
            self.assertEqual(restarted.extension_auth_key, "fixture-key")
            self.assertEqual(config.extension_refresh_interval, 4)
            self.assertEqual(restarted.captcha_method, "personal")
            self.assertEqual(restarted.yescaptcha_api_key, "old-key")

    async def test_admin_config_authentication_validation_and_secret_redaction(self):
        import copy
        import tempfile
        from unittest.mock import patch
        import httpx
        from fastapi import FastAPI
        from src.api import admin
        from src.core.config import config
        from src.core.database import Database

        saved = copy.deepcopy(config.get_raw_config())
        self.addCleanup(setattr, config, "_config", saved)
        self.addCleanup(setattr, ExtensionCaptchaService, "_instance", None)
        with tempfile.TemporaryDirectory() as directory:
            database = Database(directory + "/flow.db")
            await database.init_db()
            await database.init_config_from_toml({})
            app = FastAPI()
            app.include_router(admin.router)
            with patch.object(admin, "db", database):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                              base_url="http://localhost") as client:
                    for endpoint in ("extension-status", "extension-config", "extension-client-test"):
                        response = await client.request("GET" if endpoint.endswith("status") else "POST",
                                                        "/api/captcha/" + endpoint, json={})
                        self.assertEqual(response.status_code, 401)
                    app.dependency_overrides[admin.verify_admin_token] = lambda: "fixture-admin"
                    response = await client.post("/api/captcha/extension-config", json={"regenerate_key": True})
                    key = response.json()["auth_key"]
                    self.assertGreater(len(key), 32)
                    response = await client.post("/api/captcha/extension-config", json={"refresh_interval": 7})
                    self.assertNotIn("auth_key", response.json())
                    response = await client.get("/api/captcha/extension-status")
                    self.assertNotIn(key, response.text)
                    self.assertIs(response.json()["success"], True)
                    self.assertEqual(response.json()["success_count"], 0)
                    self.assertEqual(response.json()["refresh_interval"], 7)
                    response = await client.post("/api/captcha/extension-config", json={"refresh_interval": 0})
                    self.assertEqual(response.status_code, 422)

    async def test_flow_dispatch_preserves_action_timeout_and_return_contract(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        from src.services.flow_client import FlowClient
        from src.core.config import config

        service = ExtensionCaptchaService()
        service.get_token = AsyncMock(return_value="fixture-token")
        database = SimpleNamespace(get_captcha_config=AsyncMock(return_value=SimpleNamespace(website_key="site-key")))
        flow = FlowClient(proxy_manager=None, db=database)
        for action in ("IMAGE_GENERATION", "VIDEO_GENERATION", "UPLOAD_IMAGE", "CHAT_GENERATION"):
            with patch.dict(config._config.setdefault("captcha", {}), {"captcha_method": "extension_ws"}), \
                    patch.object(ExtensionCaptchaService, "get_instance", return_value=service):
                self.assertEqual(await flow._get_recaptcha_token("project", action), ("fixture-token", None))
            self.assertEqual(service.get_token.call_args.kwargs,
                             {"action": action, "site_key": "site-key", "timeout": 45 if action == "VIDEO_GENERATION" else 25})


class ExtensionWebsocketTests(unittest.TestCase):
        def test_asgi_websocket_authentication_and_solve_roundtrip(self):
                from fastapi import FastAPI, WebSocket
                from fastapi.testclient import TestClient

                app = FastAPI()
                service = ExtensionCaptchaService()

                @app.websocket("/ws/captcha")
                async def endpoint(socket: WebSocket):
                        await service.handle_websocket(socket)

                with TestClient(app) as client:
                        client.portal.call(service.configure, "fixture-key")
                        with client.websocket_connect("/ws/captcha") as socket:
                                socket.send_json({"type": "auth", "key": "wrong"})
                                self.assertEqual(socket.receive_json()["type"], "auth_fail")
                        with client.websocket_connect("/ws/captcha") as socket:
                                socket.send_json({"type": "auth", "key": "fixture-key"})
                                self.assertEqual(socket.receive_json()["type"], "auth_ok")
                                self.assertEqual(socket.receive_json()["type"], "config")
                                future = client.portal.start_task_soon(service.get_token)
                                solve = socket.receive_json()
                                socket.send_json({"type": "result", "id": solve["id"], "token": "fixture-token"})
                                self.assertEqual(future.result(timeout=2), "fixture-token")


class ExtensionJavascriptTests(unittest.TestCase):
    def test_proxy_permission_is_required_not_optional(self):
        root = Path(__file__).resolve().parents[1]
        manifest = json.loads((root / "chrome-extension/manifest.json").read_text())
        self.assertIn("proxy", manifest["permissions"])
        self.assertNotIn("proxy", manifest["optional_permissions"])

        @unittest.skipUnless(shutil.which("node"), "Node.js is required for extension contracts")
        def test_connection_proxy_queue_and_stale_result_contracts(self):
                source = r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const sockets = [];
const stored = {};
let control = 'controllable_by_this_extension';
let proxyConfig;
let clears = 0;
let failNext = false;
let deferScript = false;
let resolveScript;
const chrome = {
    runtime: { id: 'fixture', onMessage: event() },
    storage: { local: { get: async () => stored, set: async value => Object.assign(stored, value) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    permissions: { contains: async () => true },
    proxy: { settings: {
        get: async () => ({ levelOfControl: control }),
        set: async value => { proxyConfig = value; control = 'controlled_by_this_extension'; },
        clear: async () => { clears++; control = 'controllable_by_this_extension'; },
    } },
    webRequest: { onAuthRequired: event(), onCompleted: event(), onErrorOccurred: event() },
    tabs: {
        onRemoved: event(),
        query: async () => [1, 2, 3].map(id => ({ id })),
        get: async id => ({ id, status: 'complete', url: 'https://flow.google.com/' }),
        reload: async () => {}, create: async () => ({ id: 4 }),
    },
    scripting: { executeScript: async request => {
        if (failNext) { failNext = false; throw Error('fixture failure'); }
        if (deferScript) { deferScript = false; return new Promise(resolve => { resolveScript = resolve; }); }
        assert.equal(request.world, 'MAIN');
        return [{ result: 'fixture-token' }];
    } },
    alarms: { create: () => {}, onAlarm: event() },
};
class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
const context = vm.createContext({ chrome, WebSocket: Socket, URL, console,
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} });
vm.runInContext(input.source, context);
const run = code => vm.runInContext(code, context);
const open = socket => {
    socket.readyState = 1; socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: 'auth_ok' }) });
};
const solve = (socket, id) => socket.onmessage({ data: JSON.stringify({ type: 'solve', id, action: 'UPLOAD_IMAGE', siteKey: 'site-key' }) });
(async () => {
    await run('startup');
    assert.throws(() => run(`validateConfig({...DEFAULTS, wsUrl:'wss://example.com/ws/captcha', authKey:'key', proxyScheme:'socks5', proxyHost:'proxy.example', proxyPort:'8080', proxyUser:'user'})`), /SOCKS5/);
    await run(`handlePopup({type:'updateConfig',wsUrl:'wss://example.com/ws/captcha',authKey:'fixture-key',proxyScheme:'http',proxyHost:'proxy.example',proxyPort:'8080',proxyUser:'proxy-user',proxyPass:'proxy-pass'})`);
    await run(`handlePopup({type:'connect'})`);
    const first = sockets[0];
    first.readyState = 1; first.onopen();
    assert.equal((await run(`handlePopup({type:'getStatus'})`)).connected, false);
    first.onmessage({data:JSON.stringify({type:'auth_ok'})});
    await run('ensurePool()');
    assert.equal((await run(`handlePopup({type:'getStatus'})`)).connected, true);
    assert(proxyConfig.value.rules.bypassList.includes('172.16.0.0/12'));
    assert(proxyConfig.value.rules.bypassList.includes('example.com'));
    for (const challenge of [
        { isProxy:false, challenger:{host:'proxy.example',port:8080} },
        { isProxy:true, challenger:{host:'other.example',port:8080} },
    ]) {
        context.challenge = challenge;
        const result = await run('new Promise(resolve => proxyAuth(challenge, resolve))');
        assert.equal(result.authCredentials, undefined);
    }
    context.challenge = {isProxy:true,requestId:'one',challenger:{host:'proxy.example',port:8080}};
    assert.equal((await run('new Promise(resolve => proxyAuth(challenge, resolve))')).authCredentials.password, 'proxy-pass');
    assert.equal((await run('new Promise(resolve => proxyAuth(challenge, resolve))')).cancel, true);
    await run('applyProxy()'); await run('applyProxy()');
    assert.equal(chrome.webRequest.onAuthRequired.listeners.length, 1);
    failNext = true;
    solve(first, 'fail'); solve(first, 'recover');
    await run('solveQueue');
    assert(first.sent.some(message => message.id === 'fail' && message.error));
    assert(first.sent.some(message => message.id === 'recover' && message.token === 'fixture-token'));
    deferScript = true;
    solve(first, 'stale');
    for(let attempt = 0; attempt < 20 && !resolveScript; attempt++) await Promise.resolve();
    assert(resolveScript);
    await run(`handlePopup({type:'disconnect'})`);
    chrome.alarms.onAlarm.listeners[0]();
    assert.equal(sockets.length, 1);
    assert(clears > 0);
    await run(`handlePopup({type:'connect'})`);
    const second = sockets[1]; open(second);
    resolveScript([{result:'old-token'}]);
    await run('solveQueue');
    assert(!second.sent.some(message => message.id === 'stale'));
    control = 'controlled_by_other_extensions';
    await assert.rejects(run('applyProxy()'), /controlled/);
    await run(`handlePopup({type:'disconnect'})`);
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
                root = Path(__file__).resolve().parents[1]
                result = subprocess.run(
                        [shutil.which("node"), "-e", source],
                        input=json.dumps({"source": (root / "chrome-extension/background.js").read_text()}),
                        capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
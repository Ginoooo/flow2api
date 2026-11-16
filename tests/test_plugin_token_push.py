"""Plugin credential updates must respect account activation preferences."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI

from src.api import admin
from src.core.database import Database
from src.core.models import Token
from src.services.token_manager import TokenManager


class PluginTokenPushTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = Database(str(Path(self.directory.name) / "flow.db"))
        await self.db.init_db()
        await self.db.update_plugin_config(
            "connection-token", auto_enable_on_update=False
        )
        self.flow = MagicMock()
        self.flow.st_to_at = AsyncMock(
            return_value={
                "access_token": "validated-session",
                "expires": "2026-12-01T00:00:00Z",
            }
        )
        self.manager = TokenManager(self.db, self.flow)
        self.token_id = await self.db.add_token(
            Token(
                st="previous-session",
                at="previous-access",
                email="account@example.com",
                login_account="account@example.com",
                google_cookies="previous-cookies",
                is_active=False,
            )
        )
        self.dependencies = patch.multiple(
            admin, db=self.db, token_manager=self.manager
        )
        self.dependencies.start()
        app = FastAPI()
        app.include_router(admin.router)
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        )
        self.payload = {
            "google_cookies": "OSID=new-session; SID=account",
            "login_account": "account@example.com",
            "protocol_mode": "protocol",
        }

    async def asyncTearDown(self):
        await self.http.aclose()
        self.dependencies.stop()
        self.directory.cleanup()

    async def push(self, **overrides):
        return await self.http.post(
            "/api/plugin/update-token",
            json={**self.payload, **overrides},
            headers={"Authorization": "Bearer connection-token"},
        )

    async def test_auto_enable_disabled_keeps_disabled_account_inactive(self):
        response = await self.push()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"], "updated")
        self.assertFalse(response.json().get("auto_enabled", False))
        token = await self.db.get_token(self.token_id)
        self.assertFalse(token.is_active)
        self.assertEqual(token.google_cookies, self.payload["google_cookies"])
        self.assertEqual(token.at, "validated-session")

    async def test_auto_enable_disabled_keeps_active_account_active(self):
        await self.db.update_token(self.token_id, is_active=True)

        response = await self.push()

        self.assertEqual(response.status_code, 200)
        self.assertTrue((await self.db.get_token(self.token_id)).is_active)

    async def test_auto_enable_enabled_reactivates_account(self):
        await self.db.update_plugin_config(
            "connection-token", auto_enable_on_update=True
        )

        response = await self.push()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["auto_enabled"])
        self.assertTrue((await self.db.get_token(self.token_id)).is_active)

    async def test_failed_validation_preserves_credentials_and_disabled_state(self):
        self.flow.st_to_at.side_effect = RuntimeError("rpc=nzlxg, code=401")

        response = await self.push()

        self.assertEqual(response.status_code, 400)
        token = await self.db.get_token(self.token_id)
        self.assertEqual(token.st, "previous-session")
        self.assertEqual(token.at, "previous-access")
        self.assertEqual(token.google_cookies, "previous-cookies")
        self.assertFalse(token.is_active)

    async def test_manual_credential_update_preserves_existing_activation_behavior(
        self,
    ):
        await self.manager.update_token(self.token_id, st="manual-session")

        self.assertTrue((await self.db.get_token(self.token_id)).is_active)

    async def test_repeated_push_does_not_create_duplicate_account(self):
        for _ in range(2):
            response = await self.push()
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["action"], "updated")

        self.assertEqual(len(await self.db.get_all_tokens()), 1)


if __name__ == "__main__":
    unittest.main()

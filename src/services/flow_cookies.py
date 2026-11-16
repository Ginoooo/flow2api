"""Scoped Flow cookies, including duplicate pairs from legacy Cookie headers."""

import copy
import json
from collections import defaultdict
from http.cookies import CookieError, SimpleCookie
from http.cookiejar import CookieJar
from urllib.parse import urlparse

from .browser_cookie_utils import cookie_pairs_for_url, parse_browser_cookie_payload
from .protocol_login import _cookie_jar, _export_cookie_jar


class FlowCookieJar(CookieJar):
    def __init__(self, storage: str):
        super().__init__()
        self._original = storage
        self._runtime_added = False
        self._duplicates = {}
        for cookie in _cookie_jar(storage):
            if cookie_pairs_for_url({cookie.name: cookie.value}):
                self.set_cookie(cookie)

        values = defaultdict(list)
        for item in parse_browser_cookie_payload(storage):
            for cookie in _cookie_jar(json.dumps([item])):
                if cookie_pairs_for_url({cookie.name: cookie.value}):
                    values[self._key(cookie)].append(cookie.value)
        for cookie in self:
            pairs = values[self._key(cookie)]
            if len(pairs) > 1:
                self._duplicates[self._key(cookie)] = pairs
                # libcurl sends the first value from its jar and appends the
                # remaining pairs through CURLOPT_COOKIE in the same header.
                cookie.value = pairs[0]

    @staticmethod
    def _key(cookie):
        return cookie.domain, cookie.path, cookie.name

    @staticmethod
    def _signature(cookie):
        return cookie.value, cookie.expires, cookie.secure, cookie.domain_specified

    def export_storage(self) -> str:
        entries = json.loads(_export_cookie_jar(self, self._original))
        expanded = []
        for entry in entries:
            key = entry["domain"], entry["path"], entry["name"]
            for value in self._duplicates.get(key, [entry["value"]]):
                expanded.append({**entry, "value": value})
        return json.dumps(expanded, ensure_ascii=False, separators=(",", ":"))

    def extra_cookie_header(self, url: str) -> str:
        extras = []
        for entry in json.loads(_export_cookie_jar(self, self._original)):
            key = entry["domain"], entry["path"], entry["name"]
            if key in self._duplicates and cookie_pairs_for_url([entry], url):
                extras.extend(
                    f"{entry['name']}={value}" for value in self._duplicates[key][1:]
                )
        return "; ".join(extras)

    def add_runtime_cookies(self, runtime_cookies, url: str) -> None:
        if self._runtime_added:
            return
        self._runtime_added = True
        if not isinstance(runtime_cookies, dict):
            return
        present = {name for name, _ in cookie_pairs_for_url(self.export_storage(), url)}
        for name, value in cookie_pairs_for_url(runtime_cookies):
            if name in present:
                continue
            for cookie in _cookie_jar(
                json.dumps(
                    [
                        {
                            "name": name,
                            "value": value,
                            "url": "https://flow.google.com/",
                            "path": "/",
                            "secure": True,
                        }
                    ]
                )
            ):
                self.set_cookie(cookie)

    def replace_snapshot(self, refreshed: CookieJar, response) -> None:
        before = {self._key(cookie): self._signature(cookie) for cookie in self}
        after = {self._key(cookie): self._signature(cookie) for cookie in refreshed}
        headers = getattr(response, "headers", {}) or {}
        set_cookies = (
            headers.get_list("set-cookie")
            if hasattr(headers, "get_list")
            else [headers.get("set-cookie", "")]
        )
        explicitly_set = set()
        for header in set_cookies:
            try:
                parsed = SimpleCookie()
                parsed.load(header)
                origin = urlparse(str(response.url))
                default_path = origin.path.rpartition("/")[0] or "/"
                for name, morsel in parsed.items():
                    domain = (
                        (morsel["domain"] or origin.hostname or "").lstrip(".").lower()
                    )
                    path = (
                        morsel["path"]
                        if morsel["path"].startswith("/")
                        else default_path
                    )
                    explicitly_set.add((domain, path, name))
            except CookieError:
                continue
        self._duplicates = {
            key: values
            for key, values in self._duplicates.items()
            if (key[0].lstrip("."), key[1], key[2]) not in explicitly_set
            and before.get(key) == after.get(key)
        }
        self.clear()
        for cookie in refreshed:
            self.set_cookie(copy.copy(cookie))

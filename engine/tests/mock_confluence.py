#!/usr/bin/env python3
"""Minimal Confluence Server/Data Center REST mock for testing `kb.py fetch`.

Serves the endpoints the fetcher uses, in the 8.x shape:
  GET /rest/api/space
  GET /rest/api/content            (body.view expand, start/limit paging)
  GET /rest/api/content/{id}/child/attachment
  GET /download/attachments/{id}/{file}

Requires an Authorization header: either "Bearer test-token" or, when
--user/--password are given, HTTP Basic for those credentials. Answers 401 otherwise.
--ignore-authorization simulates a Confluence Server that does not accept tokens at
all: every request is served as an anonymous user with an empty space list.
Run: python tests/mock_confluence.py [--port 0]   (prints PORT=<n> on stdout)
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63f8cfc0000003010100c9fe92ef"
    "0000000049454e44ae426082"
)

SPACES = [
    {"key": "DBA", "name": "Databases"},
    {"key": "OPS", "name": "Operations"},
]

BODY_1001 = """<h2>Кластер Patroni</h2>
<p>Две площадки, синхронная репликация, PostgreSQL 17.</p>
<div class="code panel"><div class="codeContent panelContent">
<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: bash; gutter: false">patronictl -c /etc/patroni.yml list</pre>
</div></div>
<table class="confluenceTable"><tbody>
<tr><th class="confluenceTh">Параметр</th><th class="confluenceTh">Значение</th></tr>
<tr><td class="confluenceTd">ttl</td><td class="confluenceTd">30</td></tr>
</tbody></table>
<div class="confluence-information-macro confluence-information-macro-note">
  <p class="title">Важно</p>
  <div class="confluence-information-macro-body"><p>Кворум обязателен.</p></div>
</div>
<p><img class="confluence-embedded-image" src="/download/attachments/1001/topology.png?version=3&amp;modificationDate=1750000000000" alt="Схема"/></p>
<p>См. <a href="/pages/viewpage.action?pageId=1002">PgBouncer</a>.</p>"""

BODY_1002 = """<h2>PgBouncer</h2>
<p>Пул в режиме <code>transaction</code>.</p>"""

BODY_2001 = """<h2>Дежурство</h2>
<p>Ротация раз в неделю, эскалация через 15 минут.</p>"""

PAGES = {
    "DBA": [
        {"id": "1001", "title": "Patroni", "space": "DBA", "when": "2026-09-14T10:00:00.000+0300",
         "body": BODY_1001, "attachments": ["topology.png", "image2026-2-3 21:0:24.png"]},
        {"id": "1002", "title": "PgBouncer", "space": "DBA", "when": "2025-04-02T12:30:00.000+0300",
         "body": BODY_1002, "attachments": []},
        {"id": "1003", "title": "Пустая страница", "space": "DBA", "when": "2026-01-01T00:00:00.000+0300",
         "body": "", "attachments": []},
    ],
    "OPS": [
        {"id": "2001", "title": "Дежурство", "space": "OPS", "when": "2026-10-20T09:00:00.000+0300",
         "body": BODY_2001, "attachments": []},
    ],
}

PAGE_BY_ID = {p["id"]: p for pages in PAGES.values() for p in pages}


class Handler(BaseHTTPRequestHandler):
    token = "test-token"
    basic_user = ""
    basic_password = ""
    ignore_authorization = False
    page_size = 2          # force the client to paginate
    delay = 0.0            # seconds per listing response, for cancellation tests

    def log_message(self, *args):
        pass

    # ---- helpers -------------------------------------------------------
    def _identity(self):
        """'known' / 'anonymous' / None (credentials present but wrong, or absent)."""
        if self.ignore_authorization:
            return "anonymous"
        header = self.headers.get("Authorization") or ""
        if header == f"Bearer {self.token}":
            return "known"
        if header.startswith("Basic ") and self.basic_user:
            try:
                raw = base64.b64decode(header[6:]).decode("utf-8")
            except Exception:
                return None
            if raw == f"{self.basic_user}:{self.basic_password}":
                return "known"
        return None

    def _json(self, payload, code=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _binary(self, blob):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _authorized(self):
        identity = self._identity()
        if identity:
            return identity
        self._json({"message": "unauthorized"}, 401)
        return None

    # ---- routes --------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        path = parsed.path

        identity = self._authorized()
        if not identity:
            return

        if self.delay:
            time.sleep(self.delay)

        if path == "/rest/api/user/current":
            if identity == "anonymous":
                return self._json({"type": "anonymous", "displayName": "Anonymous"})
            return self._json({
                "type": "known",
                "username": self.basic_user or "api-token-user",
                "displayName": self.basic_user or "API token user",
            })

        if path == "/rest/api/space":
            if identity == "anonymous":
                return self._json({"results": [], "size": 0, "totalSize": 0, "start": 0, "limit": self.page_size})
            start = int(q.get("start", 0))
            batch = SPACES[start:start + self.page_size]
            return self._json({"results": batch, "size": len(batch), "totalSize": len(SPACES),
                               "start": start, "limit": self.page_size})

        if path == "/rest/api/content":
            if identity == "anonymous":
                return self._json({"results": [], "size": 0, "totalSize": 0, "start": 0})
            space = q.get("spaceKey")
            pages = PAGES.get(space, [])
            start = int(q.get("start", 0))
            batch = pages[start:start + self.page_size]
            results = []
            for p in batch:
                results.append({
                    "id": p["id"], "title": p["title"], "type": "page",
                    "space": {"key": p["space"]},
                    "version": {"number": 1, "when": p["when"]},
                    "body": {"view": {"value": p["body"], "representation": "view"}},
                })
            # Confluence Server omits `totalSize` here, which is exactly why the
            # fetcher must count pages through the search endpoint instead.
            return self._json({"results": results, "size": len(results),
                               "start": start})

        if path == "/rest/api/content/search":
            # CQL shape the incremental fetch uses:
            #   type=page and space="KEY" and lastmodified > "YYYY-MM-DD"
            cql = q.get("cql", "")
            m = re.search(r'space\s*=\s*"([^"]+)"', cql)
            since = re.search(r'lastmodified\s*>\s*"([^"]+)"', cql)
            pages = PAGES.get(m.group(1), []) if m else []
            if identity == "anonymous":
                pages = []
            if since:
                pages = [p for p in pages if p["when"][:10] > since.group(1)]
            start = int(q.get("start", 0))
            batch = pages[start:start + self.page_size]
            results = [{
                "id": p["id"], "title": p["title"], "type": "page",
                "space": {"key": m.group(1) if m else p["space"]},
                "version": {"number": 1, "when": p["when"]},
                "body": {"view": {"value": p["body"], "representation": "view"}},
            } for p in batch]
            return self._json({"results": results, "size": len(results), "totalSize": len(pages),
                               "start": start})

        if path.startswith("/rest/api/content/") and path.endswith("/child/attachment"):
            pid = path.split("/")[4]
            page = PAGE_BY_ID.get(pid) or {}
            results = [{
                "title": name,
                "id": f"att-{pid}-{name}",
                "_links": {"download": f"/download/attachments/{pid}/{name}?version=3"},
            } for name in page.get("attachments", [])]
            return self._json({"results": results, "size": len(results)})

        if path.startswith("/download/attachments/"):
            return self._binary(PNG)

        self._json({"message": "not found: " + path}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token", default="test-token")
    ap.add_argument("--user", default="", help="accept HTTP Basic for this user")
    ap.add_argument("--password", default="")
    ap.add_argument("--ignore-authorization", action="store_true",
                    help="serve every request as an anonymous user, like a server without token support")
    ap.add_argument("--delay", type=float, default=0.0, help="seconds added to each listing response")
    args = ap.parse_args()
    Handler.token = args.token
    Handler.basic_user = args.user
    Handler.basic_password = args.password
    Handler.ignore_authorization = args.ignore_authorization
    Handler.delay = args.delay
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT={srv.server_address[1]}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    sys.exit(main())

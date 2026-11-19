#!/usr/bin/env python3
"""Build a synthetic Confluence HTML export (zip) for testing kb.py.

Mimics the layout of an Atlassian Confluence 7/8 HTML space export:
  index.html
  <Page+Title>_<pageId>.html
  attachments/<pageId>/<file>
"""
import io
import sys
import zipfile
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "fixture-export.zip")

# 1x1 png
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63f8cfc0000003010100c9fe92ef"
    "0000000049454e44ae426082"
)


def page(pid, title, space, body, updated="", url=None):
    canon = url or f"https://confluence.example.local/pages/viewpage.action?pageId={pid}"
    meta_date = f'\n<span class="date">{updated}</span>' if updated else ""
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="ajs-page-id" content="{pid}">
<meta name="ajs-space-name" content="{space}">
<title>{title} - {space} - Confluence</title>
<link rel="canonical" href="{canon}">
</head>
<body>
<div id="page">
<div id="breadcrumb-section">
  <ol id="breadcrumbs">
    <li><a href="index.html">Spaces</a></li>
    <li><a href="#">{space}</a></li>
  </ol>
</div>
<div id="main-content" class="wiki-content">
{body}
</div>
<div id="page-metadata" class="page-metadata">{meta_date}
  <span class="last-modified">Last modified on 2025-03-14 by admin</span>
</div>
<div id="footer">Powered by Atlassian Confluence 8.5.4</div>
<div id="comments-section"><h3>Comments</h3><p>Комментарий, который не нужен в базе.</p></div>
</div>
</body>
</html>
"""


PAGE_101 = page(101, "Настройка Patroni в двух ЦОД", "DBA", """
<h1>Настройка Patroni в двух ЦОД</h1>
<p>Кластер PostgreSQL 16 под управлением Patroni, две площадки, синхронная репликация.</p>

<div class="confluence-information-macro confluence-information-macro-note">
  <p class="title">Важно</p>
  <div class="confluence-information-macro-body">
    <p>Начиная с Patroni 3.2 параметр <code>synchronous_mode</code> обязателен для двух ЦОД.</p>
  </div>
</div>

<h2>Параметры etcd</h2>
<table class="confluenceTable">
  <tbody>
  <tr><th class="confluenceTh">Параметр</th><th class="confluenceTh">Значение</th></tr>
  <tr><td class="confluenceTd">etcd_endpoints</td><td class="confluenceTd">192.0.2.11:2379,192.0.2.12:2379</td></tr>
  <tr><td class="confluenceTd">ttl</td><td class="confluenceTd">30</td></tr>
  </tbody>
</table>

<h2>Конфигурация</h2>
<div class="code panel"><div class="codeContent panelContent">
<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: yaml; gutter: false">scope: pg_cluster
name: pg01
restapi:
  listen: 0.0.0.0:8008
bootstrap:
  dcs:
    synchronous_mode: true</pre>
</div></div>

<h2>Чек-лист</h2>
<ul class="inline-task-list">
  <li data-inline-task-id="1" class="checked"><input type="checkbox" checked="checked"> Проверить DNS между ЦОД</li>
  <li data-inline-task-id="2"><input type="checkbox"> Прогнать pg_rewind</li>
</ul>

<h2>Схема</h2>
<p><img class="confluence-embedded-image" src="attachments/101/topology.png" alt="Схема ЦОД"></p>
<p><img class="confluence-embedded-image" src="/download/attachments/101/image2026-2-3%2021%3A0%3A24.png?version=1" alt="Снимок метрик"></p>

<div class="expand-container"><div class="expand-control"><span class="expand-control-text">Грабли</span></div>
<div class="expand-content"><p>При переключении на второй ЦОД watchdog может убить мастер раньше, чем успеет отработать promote.</p></div>
</div>

<p>Смежная страница: <a href="PgBouncer_102.html">PgBouncer для быстрого старта</a>, а также
<a href="https://db.example.local/pages/viewpage.action?pageId=903">внешний runbook</a>.</p>
""", updated="2025-03-14")

PAGE_102 = page(102, "PgBouncer для быстрого старта", "DBA", """
<h1>PgBouncer для быстрого старта</h1>
<p>Пул <code>pool_mode = transaction</code>, база <strong>appdb</strong>, лимит 200 соединений.</p>
<div class="confluence-information-macro confluence-information-macro-tip">
  <div class="confluence-information-macro-body"><p>Держите <code>default_pool_size</code> ниже <code>max_connections</code> в 3–4 раза.</p></div>
</div>
<pre><code class="language-ini">[databases]
appdb = host=192.0.2.21 dbname=appdb

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000</code></pre>
<p>См. также <a href="%D0%9D%D0%B0%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0+Patroni_101.html">Patroni</a>.</p>
""", updated="2024-11-02")

PAGE_103 = page(103, "Сеть площадок и маршрутизация", "Infra", """
<h1>Сеть площадок и маршрутизация</h1>
<p>VLAN 100 — сервисный, VLAN 200 — репликация. Шлюз <code>192.0.2.1</code>.</p>
<table><tbody>
<tr><td colspan="2">Сводка</td></tr>
<tr><td>А</td><td>B</td></tr>
</tbody></table>
<ol><li>Проверить BGP<li>Проверить nftables</ol>
<div class="toc-macro"><ul><li><a href="#a">Содержание</a></li></ul></div>
""", updated="2022-06-01")

INDEX = """<html><head><meta charset="UTF-8"><title>Spaces</title></head>
<body><h1>Confluence spaces</h1>
<ul><li><a href="DBA_101.html">DBA</a></li><li><a href="Infra_103.html">Infra</a></li></ul>
</body></html>"""


def build(path: Path, drop=(), extra101="", date101="2025-03-14"):
    written = []
    html101 = PAGE_101
    if extra101:
        html101 = html101.replace("</h1>", "</h1>\n" + extra101, 1)
    if date101 != "2025-03-14":
        html101 = html101.replace("2025-03-14", date101)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("index.html", INDEX)
        for pid, title, html, name in (
            (101, "Настройка Patroni в двух ЦОД", html101, "Настройка+Patroni_101.html"),
            (102, "PgBouncer для быстрого старта", PAGE_102, "PgBouncer_102.html"),
            (103, "Сеть площадок и маршрутизация", PAGE_103, "Сеть+площадок_103.html"),
        ):
            if pid in drop:
                continue
            zf.writestr(name, html)
            written.append(name)
        zf.writestr("attachments/101/topology.png", PNG)
        # Confluence keeps ':' in an attachment title; a zip made from those pages
        # carries it through and Windows refuses to create the file.
        zf.writestr("attachments/101/image2026-2-3 21:0:24.png", PNG)
        zf.writestr("attachments/102/pgbouncer.ini", "[databases]\n")
        zf.writestr("styles/main.css", "body{}")
    return written


def space_index(key: str, name: str) -> str:
    """The Key/Name table a real multi-space export keeps in each space folder."""
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>{name} - Confluence</title></head>
<body><div id="main-content">
<table class="confluenceTable">
<tr><th class="confluenceTh">Key</th><td class="confluenceTd">{key}</td></tr>
<tr><th class="confluenceTh">Name</th><td class="confluenceTd">{name}</td></tr>
</table>
<ul><li><a href="{key}_page.html">Home</a></li></ul>
</div></body></html>"""


def build_two_spaces(path: Path):
    """A zip shaped like a multi-space export: one folder per space with index.html.

    Used to test the file source end to end: space discovery from the archive,
    `import --spaces` narrowing, and the tombstone safety that narrowing needs.
    """
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("DBA/index.html", space_index("DBA", "Databases"))
        zf.writestr("DBA/101.html", page(101, "Настройка Patroni", "Databases", """
<h1>Настройка Patroni</h1><p>Кластер PostgreSQL 16, две площадки, Patroni 4.0.</p>""",
                                         updated="2026-02-10"))
        zf.writestr("OPS/index.html", space_index("OPS", "Operations"))
        zf.writestr("OPS/201.html", page(201, "Дежурство", "Operations", """
<h1>Дежурство</h1><p>Ротация раз в неделю, эскалация через 15 минут.</p>""",
                                        updated="2026-03-01"))


def build_duplicate_ids(path: Path):
    """Two legacy pages whose file names claim the same page id.

    Real exports do repeat an id (the same page saved twice, an older export
    merged into a newer one). The importer must keep one file and the index one
    row instead of failing on a UNIQUE constraint.
    """
    def page(title: str, text: str) -> str:
        return f"""<html><head><meta charset="UTF-8"><title>{title} - Legacy - Confluence</title></head>
<body><div class="wiki-content"><h1>{title}</h1><p>{text}</p></div></body></html>"""

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("First--900.html", page("First", "Первый текст про кластер Patroni."))
        zf.writestr("Second--900.html", page("Second", "Второй текст про кластер Patroni."))


def build_legacy(path: Path):
    """A pre-Confluence-6 export: no ajs metadata, loose markup, no closing tags."""
    html = """<html><head><meta charset="UTF-8"><title>Старая страница - Legacy - Confluence</title></head>
<body><div class="wiki-content">
<h1><span class="mw-headline">Старая страница</span></h1>
<p>Текст с <b>жирным</b> и <a href="Настройка+Patroni_101.html"><i>курсивной ссылкой</i></a>.
<ul><li><p>Первый пункт
<li><p>Второй пункт
</ul>
<pre>echo hello
echo world</pre>
</div></body></html>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Старая+страница_777.html", html)


def build_cp1251(path: Path):
    """A legacy export saved in windows-1251, as older Confluence versions did."""
    html = """<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251">
<title>Резервное копирование - Ops - Confluence</title></head>
<body><div id="main-content"><h1>Резервное копирование PostgreSQL</h1>
<p>Ежедневный basebackup в 02:00, retention 14 дней.</p>
</div></body></html>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Резервное+копирование_888.html", html.encode("cp1251"))


if __name__ == "__main__":
    w = build(OUT)
    print(f"wrote {OUT} with {len(w)} pages")

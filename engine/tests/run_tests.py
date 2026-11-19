#!/usr/bin/env python3
"""End-to-end checks for kb.py against a synthetic Confluence export.

Run:  python tests/run_tests.py
Each case rebuilds a temporary KB from scratch, so it never touches a real one.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
KB_PY = ROOT / "kb.py"
PY = sys.executable
sys.path.insert(0, str(HERE))
import make_fixture  # noqa: E402

WORK = HERE / "_work"
failures = []
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        failures.append(name)


def run(*args, kb=WORK / "kb"):
    cmd = [PY, str(KB_PY), "--kb", str(kb), *args]
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")


def manifest(kb=WORK / "kb"):
    rows = {}
    path = kb / "MANIFEST.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["id"]] = row
    return rows


def article(kb, pid):
    for md in (kb).rglob(f"*--{pid}.md"):
        return md
    return None


def reset():
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)


def main():
    reset()
    v1 = WORK / "v1.zip"
    v2 = WORK / "v2.zip"
    make_fixture.build(v1)
    kb = WORK / "kb"

    print("case 1: first import")
    r = run("import", "--zip", str(v1), "--base-url", "https://confluence.example.local")
    check("exit 0", r.returncode == 0, r.stderr[-400:])
    check("3 pages added", "added      3" in r.stdout, r.stdout)
    m = manifest()
    check("manifest has 3 rows", len(m) == 3, str(len(m)))
    check("page id parsed from meta", "101" in m)
    fm_text = article(kb, "101").read_text(encoding="utf-8")
    check("frontmatter has source_updated", "source_updated: 2025-03-14" in fm_text)
    check("code fence with language", "```yaml" in fm_text)
    check("callout rendered", "> [!NOTE] Важно" in fm_text)
    check("task list rendered", "- [x] Проверить DNS" in fm_text)
    check("internal link resolved", "--102.md)" in fm_text)
    check("image points at attachments", "](../attachments/101/topology.png)" in fm_text)
    check("noise removed", "Powered by Atlassian" not in fm_text and "Комментарий" not in fm_text)
    complex_md = article(kb, "103").read_text(encoding="utf-8")
    check("complex table kept as html", complex_md.count("<table>") == 1, complex_md)
    check("ol items split", "2. Проверить nftables" in complex_md, complex_md)
    check("unique index file", (kb / "INDEX.md").exists())
    check("attachment with ':' is written under a safe name",
          (kb / "attachments" / "101" / "image2026-2-3 21_0_24.png").exists(),
          str([p.name for p in (kb / "attachments" / "101").iterdir()]) if (kb / "attachments" / "101").exists() else "no attachments dir")
    check("article links the same safe name",
          "](../attachments/101/image2026-2-3 21_0_24.png)" in fm_text, fm_text[:600])

    print("case 2: annotations survive a no-op reimport")
    p101 = article(kb, "101")
    text = p101.read_text(encoding="utf-8")
    text = text.replace("status: current", "status: legacy\ntags: [\"patroni\", \"dc\"]\nnotes: \"ручная пометка в шапке\"")
    text = text.replace("## Параметры etcd", "## Параметры etcd\n\nРучная пометка: проверить 2026-11.")
    p101.write_text(text, encoding="utf-8")
    r = run("import", "--zip", str(v1), "--base-url", "https://confluence.example.local")
    check("all unchanged", "unchanged  3" in r.stdout, r.stdout)
    after = article(kb, "101").read_text(encoding="utf-8")
    check("manual body edit kept", "Ручная пометка" in after)
    check("manual status kept", "status: legacy" in after)
    check("manual tags kept", "patroni" in after)

    print("case 3: reimport with a changed and a dropped page")
    make_fixture.build(
        v2, drop=(103,), date101="2026-09-01",
        extra101="<p>Обновление 2026: переход на Patroni 4.0, synchronous_mode = quorum.</p>",
    )
    r = run("import", "--zip", str(v2), "--base-url", "https://confluence.example.local")
    check("exit 0", r.returncode == 0, r.stderr[-400:])
    check("one changed", "changed    1" in r.stdout, r.stdout)
    check("one unchanged", "unchanged  1" in r.stdout, r.stdout)
    check("one deprecated", "deprecated 1" in r.stdout, r.stdout)
    changed = article(kb, "101").read_text(encoding="utf-8")
    check("new text present", "Patroni 4.0" in changed)
    check("new source date", "source_updated: 2026-09-01" in changed)
    check("body edit dropped on change (documented)", "Ручная пометка" not in changed)
    check("frontmatter notes survived the update", "ручная пометка в шапке" in changed)
    check("manual status survived the update", "status: legacy" in changed)
    gone = article(kb, "103").read_text(encoding="utf-8")
    check("dropped page tombstoned", "status: deprecated" in gone and "deprecated_on:" in gone)
    check("dropped page file still exists", article(kb, "103") is not None)
    check("manifest marks it deprecated", manifest()["103"]["status"] == "deprecated")

    print("case 4: search")
    r = run("search", "etcd")
    check("search finds etcd page", "Настройка Patroni" in r.stdout, r.stdout)
    check("snippet has no markdown pipes", "|" not in r.stdout, r.stdout)
    r = run("search", "pgbouncer")
    check("search finds pgbouncer", "PgBouncer" in r.stdout, r.stdout)
    r = run("search", "synchronous_mode")
    check("underscore term searchable", "Patroni" in r.stdout, r.stdout)
    r = run("search", "несуществующееслово")
    check("no-match message", "no matches" in r.stdout, r.stdout)

    print("case 5: audit and stats")
    r = run("audit", "--json")
    data = json.loads(r.stdout)
    check("audit flags deprecated page", any(i["status"] == "deprecated" for i in data), r.stdout[:300])
    ids = {i["id"] for i in data}
    check("audit flags stale 2024 page", "102" in ids, str(ids))
    r = run("stats")
    check("stats counts 3 articles", "articles: 3" in r.stdout, r.stdout)

    print("case 6: index rebuild is idempotent and db is queryable")
    r = run("index")
    check("index exit 0", r.returncode == 0, r.stderr[-300:])
    con = sqlite3.connect(str(kb / "kb.sqlite"))
    n = con.execute("SELECT count(*) FROM meta").fetchone()[0]
    con.close()
    check("meta table filled", n == 3, str(n))
    r = run("get", "PgBouncer")
    check("get by title", "pool_mode" in r.stdout, r.stdout[:200])

    print("case 7: legacy export without metadata")
    legacy = WORK / "legacy.zip"
    make_fixture.build_legacy(legacy)
    kb2 = WORK / "kb-legacy"
    r = run("import", "--zip", str(legacy), kb=kb2)
    check("legacy exit 0", r.returncode == 0, r.stderr[-400:])
    check("page id from filename", '"id": "777"' in (kb2 / "MANIFEST.jsonl").read_text(encoding="utf-8"))
    art = next(kb2.rglob("*--777.md"), None)
    check("legacy article written", art is not None)
    if art:
        txt = art.read_text(encoding="utf-8")
        check("legacy title from h1", "title: Старая страница" in txt, txt[:300])
        check("legacy list split", "- Первый пункт" in txt and "- Второй пункт" in txt, txt)
        check("legacy pre without lang", "```\necho hello" in txt, txt)
        check("legacy link unresolved but marked", "confluence:pageId=101" in txt, txt)

    print("case 8: windows-1251 export")
    cp = WORK / "cp1251.zip"
    make_fixture.build_cp1251(cp)
    kb3 = WORK / "kb-cp1251"
    r = run("import", "--zip", str(cp), kb=kb3)
    check("cp1251 exit 0", r.returncode == 0, r.stderr[-400:])
    art = next(kb3.rglob("*--888.md"), None)
    check("cp1251 article written", art is not None)
    if art:
        txt = art.read_text(encoding="utf-8")
        check("cp1251 title decoded", "Резервное копирование PostgreSQL" in txt, txt[:300])
        check("no replacement chars", "\ufffd" not in txt, txt[:300])

    print("case 9: REST API fetch against a Confluence 8.x mock")
    mock = subprocess.Popen(
        [PY, str(HERE / "mock_confluence.py"), "--port", "0"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
    )
    try:
        first = mock.stdout.readline().strip()
        port = first.split("=", 1)[1]
        url = f"http://127.0.0.1:{port}"

        kb4 = WORK / "kb-api"
        r = run("fetch", "--url", url, "--token", "test-token", "--space-type", "all", kb=kb4)
        check("fetch exit 0", r.returncode == 0, r.stderr[-500:])
        check("3 non-empty pages imported", "added      3" in r.stdout, r.stdout + r.stderr[-300:])
        m4 = manifest(kb4)
        check("spaces split from index.html", len({row["space"] for row in m4.values()}) == 2,
              str({row["space"] for row in m4.values()}))
        art = article(kb4, "1001")
        check("api article written", art is not None)
        if art:
            txt = art.read_text(encoding="utf-8")
            check("version.when became source_updated", "source_updated: 2026-09-14" in txt, txt[:300])
            check("canonical url used", "viewpage.action?pageId=1001" in txt, txt[:300])
            check("code fence language from brush", "```bash" in txt, txt)
            check("note macro rendered", "> [!NOTE] Важно" in txt, txt)
            check("attachment rewritten without query", "(../attachments/1001/topology.png)" in txt, txt)
            check("cross-page link resolved", "(pgbouncer--1002.md)" in txt, txt)
        check("attachment downloaded", (kb4 / "attachments" / "1001" / "topology.png").exists())
        check("an attachment title with ':' stays extractable",
              (kb4 / "attachments" / "1001" / "image2026-2-3 21_0_24.png").exists(),
              str([p.name for p in (kb4 / "attachments" / "1001").iterdir()]))

        r = run("fetch", "--url", url, "--token", "test-token", "--list-spaces", kb=kb4)
        check("list-spaces lists both", "DBA" in r.stdout and "OPS" in r.stdout, r.stdout[:300])

        r = run("fetch", "--url", url, "--token", "wrong", kb=WORK / "kb-api-bad")
        check("bad token rejected", r.returncode == 2 and "401" in r.stderr, r.stderr[:300])

        r = run("fetch", "--url", url, "--token", "test-token", "--spaces", "OPS", kb=WORK / "kb-api-one")
        check("--spaces filter works", "added      1" in r.stdout, r.stdout + r.stderr[-200:])
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()

    print("case 10: --progress contract (archive source)")
    kb5 = WORK / "kb-progress"
    r = run("import", "--zip", str(v1), "--progress", kb=kb5)
    check("progress exit 0", r.returncode == 0, r.stderr[-300:])
    lines = [ln for ln in r.stderr.splitlines() if ln.startswith("PROGRESS ")]
    check("start line plus one line per page", len(lines) == 4, str(lines))
    parsed = []
    for ln in lines:
        m = re.fullmatch(r"PROGRESS (\d+)/(\d+)(?: (.*))?", ln)
        parsed.append((int(m.group(1)), int(m.group(2)), (m.group(3) or "")) if m else (None, None, ln))
    check("every line matches `PROGRESS <done>/<total> [space]`",
          all(d is not None for d, _, _ in parsed), str(parsed))
    check("total is the page-file count", {t for _, t, _ in parsed} == {3}, str(parsed))
    check("counter runs 0..total without gaps", [d for d, _, _ in parsed] == [0, 1, 2, 3], str(parsed))
    check("space names reach the reader", {s for _, _, s in parsed} - {""} == {"DBA", "Infra"}, str(parsed))
    check("summary counts pages, not space folders", "added      3" in r.stdout, r.stdout)

    print("case 11: file source — space discovery and --spaces narrowing")
    two = WORK / "two-spaces.zip"
    make_fixture.build_two_spaces(two)
    r = run("inspect", "--zip", str(two), "--json")
    data = json.loads(r.stdout)
    check("inspect exit 0 and ok", r.returncode == 0 and data.get("ok") is True, r.stdout[:300])
    check("inspect counts pages", data.get("pages") == 2, str(data.get("pages")))
    check("inspect reads spaces from index.html",
          {(s["key"], s["name"], s["pages"]) for s in data.get("spaces", [])}
          == {("DBA", "Databases", 1), ("OPS", "Operations", 1)}, str(data.get("spaces")))
    kb6 = WORK / "kb-two"
    r = run("import", "--zip", str(two), kb=kb6)
    check("both spaces imported", "added      2" in r.stdout, r.stdout)
    r = run("import", "--zip", str(two), "--spaces", "DBA", kb=kb6)
    check("narrowed import exit 0", r.returncode == 0, r.stderr[-300:])
    check("narrowing is reported", "filtered   1" in r.stdout, r.stdout)
    check("unselected space is not tombstoned", manifest(kb6)["201"]["status"] == "current",
          str(manifest(kb6)["201"]))
    check("unselected article still current", "status: deprecated" not in article(kb6, "201").read_text(encoding="utf-8"))
    r = run("import", "--zip", str(two), "--spaces", "NOPE", kb=kb6)
    check("unknown space rejected", r.returncode == 3 and "none of the requested spaces" in r.stderr, r.stderr)

    print("case 12: inspect rejects what the file source must not accept")
    r = run("inspect", "--zip", str(WORK / "absent.zip"), "--json")
    check("missing file -> code file-missing",
          r.returncode == 2 and json.loads(r.stdout)["code"] == "file-missing", r.stdout)
    not_zip = WORK / "not-a-zip.zip"
    not_zip.write_text("hello", encoding="utf-8")
    r = run("inspect", "--zip", str(not_zip), "--json")
    check("plain file -> code file-not-zip",
          r.returncode == 2 and json.loads(r.stdout)["code"] == "file-not-zip", r.stdout)
    empty = WORK / "empty.zip"
    empty.write_bytes(b"")
    r = run("inspect", "--zip", str(empty), "--json")
    check("empty file -> code file-empty",
          r.returncode == 2 and json.loads(r.stdout)["code"] == "file-empty", r.stdout)
    no_html = WORK / "no-html.zip"
    with __import__("zipfile").ZipFile(no_html, "w") as zf:
        zf.writestr("readme.txt", "nothing here")
    r = run("inspect", "--zip", str(no_html), "--json")
    check("archive without pages -> code file-no-pages",
          r.returncode == 2 and json.loads(r.stdout)["code"] == "file-no-pages", r.stdout)

    print("case 13: --progress contract (REST source)")
    mock = subprocess.Popen(
        [PY, str(HERE / "mock_confluence.py"), "--port", "0"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
    )
    try:
        port = mock.stdout.readline().strip().split("=", 1)[1]
        url = f"http://127.0.0.1:{port}"
        r = run("fetch", "--url", url, "--token", "test-token", "--progress",
                "--space-type", "all", kb=WORK / "kb-api-progress")
        check("fetch progress exit 0", r.returncode == 0, r.stderr[-400:])
        lines = [ln for ln in r.stderr.splitlines() if ln.startswith("PROGRESS ")]
        check("fetch progress covers every listed page", len(lines) == 5, str(lines))
        last = lines[-1].split(" ")
        check("fetch progress ends at total", last[1].split("/")[0] == last[1].split("/")[1], last[1])
        totals = {int(ln.split(" ")[1].split("/")[1]) for ln in lines}
        check("full fetch knows its page total from the CQL count", totals == {4}, str(totals))
        check("fetch progress names both spaces",
              {"DBA", "OPS"} <= {ln.rsplit(" ", 1)[-1] for ln in lines}, str(lines))

        print("case 14: incremental fetch via CQL search")
        r = run("fetch", "--url", url, "--token", "test-token", "--spaces", "DBA",
                "--since", "2025-01-01", kb=WORK / "kb-api-since")
        check("since fetch exit 0", r.returncode == 0, r.stderr[-400:])
        check("only newer pages imported", "added      2" in r.stdout, r.stdout + r.stderr[-200:])
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()

    print("case 15: the skill ships the same engine")
    twins = [ROOT / "kb.py", ROOT.parent / "skill" / "scripts" / "kb.py"]
    if all(p.exists() for p in twins):
        check("skill copy matches engine/kb.py",
              twins[0].read_bytes() == twins[1].read_bytes(),
              "copy skill/scripts/kb.py from engine/kb.py")

    print("case 16: file-name rules for attachment titles")
    sys.path.insert(0, str(ROOT))
    import kb as kb_mod  # noqa: E402  (imported here so the CLI cases stay isolated)
    check("colon becomes an underscore",
          kb_mod.safe_component("image2026-2-3 21:0:24.png") == "image2026-2-3 21_0_24.png",
          kb_mod.safe_component("image2026-2-3 21:0:24.png"))
    check("windows-forbidden characters are all replaced",
          not any(ch in kb_mod.safe_component('a<b>c:d"e/f\\g|h?i*j.png') for ch in '<>:"/\\|?*'),
          kb_mod.safe_component('a<b>c:d"e/f\\g|h?i*j.png'))
    check("reserved device names are prefixed",
          kb_mod.safe_component("CON.txt") == "_CON.txt" and kb_mod.safe_component("lpt1") == "_lpt1",
          kb_mod.safe_component("CON.txt"))
    check("trailing dots and spaces are dropped",
          kb_mod.safe_component("report. . ") == "report", kb_mod.safe_component("report. . "))
    check("an empty name still yields a component", kb_mod.safe_component("   ") == "_")
    long_name = kb_mod.safe_component("x" * 300 + ".png")
    check("long names keep their extension", len(long_name) <= 120 and long_name.endswith(".png"), str(len(long_name)))

    print("case 17: two archive files claiming one page id")
    dupes = WORK / "dupes.zip"
    make_fixture.build_duplicate_ids(dupes)
    kb7 = WORK / "kb-dupes"
    r = run("import", "--zip", str(dupes), kb=kb7)
    check("duplicate-id import exits 0", r.returncode == 0, r.stderr[-500:])
    check("the stale twin is reported", "duplicates 1" in r.stdout, r.stdout)
    survivors = list(kb7.rglob("*--900.md"))
    check("exactly one article file for the id", len(survivors) == 1, str([f.name for f in survivors]))
    check("the last written page wins", bool(survivors) and survivors[0].name.startswith("second"),
          str([f.name for f in survivors]))
    con = sqlite3.connect(str(kb7 / "kb.sqlite"))
    indexed = con.execute("SELECT count(*) FROM meta WHERE id = '900'").fetchone()[0]
    con.close()
    check("the index holds one row for the id", indexed == 1, str(indexed))

    # A hand-copied twin must not break indexing either.
    if survivors:
        shutil.copy(survivors[0], survivors[0].parent / "manual-copy--900.md")
        r = run("index", kb=kb7)
        check("index survives a duplicate id", r.returncode == 0, r.stderr[-400:])
        check("index warns about the twin", "repeat a page id" in r.stderr, r.stderr[-400:])
        con = sqlite3.connect(str(kb7 / "kb.sqlite"))
        indexed = con.execute("SELECT count(*) FROM meta").fetchone()[0]
        con.close()
        check("still one row per id after reindex", indexed == 1, str(indexed))

    print("case 18: a base packs and unpacks as a portable archive")
    meta_file = WORK / "base-meta.json"
    meta_file.write_text(json.dumps({
        "name": "Demо", "source": "api", "baseUrl": "https://confluence.example.local",
        "spaces": ["DBA"], "spacesAll": False, "locale": "ru",
    }, ensure_ascii=False), encoding="utf-8")
    (kb / "raw").mkdir(exist_ok=True)
    (kb / "raw" / "cache.bin").write_bytes(b"not part of the corpus")
    # A page may attach a markdown file: it travels with the archive but is not
    # an article and must not inflate the count.
    (kb / "attachments" / "101").mkdir(parents=True, exist_ok=True)
    (kb / "attachments" / "101" / "notes.md").write_text("# notes\n", encoding="utf-8")
    base_zip = WORK / "base.zip"
    r = run("pack", "--out", str(base_zip), "--meta", str(meta_file), "--progress", "--json")
    check("pack exits 0", r.returncode == 0, r.stderr[-400:])
    packed = json.loads(r.stdout.strip().splitlines()[-1])
    check("pack reports the articles", packed.get("articles") == 3, str(packed))
    progress = [(int(a), int(b)) for a, b in re.findall(r"^PACK (\d+)/(\d+)$", r.stderr, re.M)]
    check("pack reports byte progress", bool(progress), r.stderr[-300:])
    if progress:
        check("progress starts at zero", progress[0][0] == 0, str(progress[0]))
        check("progress ends at the total", progress[-1][0] == progress[-1][1] > 0, str(progress[-1]))
    with zipfile.ZipFile(base_zip) as zf:
        names = zf.namelist()
        payload = json.loads(zf.read("knowledge-base.json").decode("utf-8"))
        check("archive carries the format marker", payload.get("format") == "dsh-knowledge-base-base")
        check("archive carries the base url", payload["source"].get("baseUrl") == "https://confluence.example.local")
        check("archive carries no credentials", not any(
            key in payload["source"] for key in ("token", "password", "user", "auth")))
        check("archive keeps the articles", any(name.endswith("--101.md") for name in names), str(names[:5]))
        check("archive keeps the index", "kb/kb.sqlite" in names, str(names[:5]))
        check("archive keeps a markdown attachment", "kb/attachments/101/notes.md" in names, str(names[:5]))
        check("a markdown attachment is not an article", packed.get("articles") == 3, str(packed))
        check("archive leaves the export cache behind", not any(name.startswith("kb/raw/") for name in names))
        check("archive leaves v1 state behind", "kb/connection.json" not in names)
    checked = run("unpack", "--archive", str(base_zip), "--check", "--json")
    check("unpack --check exits 0", checked.returncode == 0, checked.stderr[-300:])
    summary = json.loads(checked.stdout.strip().splitlines()[-1])
    check("check reports three articles", summary.get("articles") == 3, str(summary))
    check("check names the base url", summary["source"].get("baseUrl") == "https://confluence.example.local")
    check("check writes nothing", not (WORK / "kb-check").exists())
    kb_copy = WORK / "kb-copy"
    r = run("unpack", "--archive", str(base_zip), "--json", kb=kb_copy)
    check("unpack exits 0", r.returncode == 0, r.stderr[-400:])
    check("copy has the same article count",
          "articles: 3" in run("stats", kb=kb_copy).stdout, run("stats", kb=kb_copy).stdout)
    found = run("search", "Patroni", "-n", "1", kb=kb_copy)
    check("copy is searchable after the move", "Patroni" in found.stdout, found.stdout[-300:])

    print("case 19: a hostile or foreign archive is refused")
    evil = WORK / "evil.zip"
    with zipfile.ZipFile(evil, "w") as zf:
        zf.writestr("knowledge-base.json", json.dumps({"format": "dsh-knowledge-base-base", "version": 1, "source": {}}))
        zf.writestr("kb/../../evil.txt", "x")
    r = run("unpack", "--archive", str(evil), "--check", "--json")
    check("path traversal is refused", '"code": "archive-unsafe"' in r.stdout, r.stdout[-300:])
    foreign = WORK / "foreign.zip"
    with zipfile.ZipFile(foreign, "w") as zf:
        zf.writestr("kb/x.md", "x")
    r = run("unpack", "--archive", str(foreign), "--check", "--json")
    check("an archive without the marker is refused", '"archive-meta-missing"' in r.stdout, r.stdout[-300:])
    wrong = WORK / "wrong.zip"
    with zipfile.ZipFile(wrong, "w") as zf:
        zf.writestr("knowledge-base.json", json.dumps({"format": "something-else", "version": 1}))
        zf.writestr("kb/x.md", "x")
    r = run("unpack", "--archive", str(wrong), "--check", "--json")
    check("a foreign format is refused", '"archive-format"' in r.stdout, r.stdout[-300:])
    r = run("unpack", "--archive", str(WORK / "nope.zip"), "--check", "--json")
    check("a missing archive is refused", '"archive-missing"' in r.stdout, r.stdout[-300:])

    print("case 19b: an archive with the earlier marker still opens")
    legacy = WORK / "legacy-base.zip"
    with zipfile.ZipFile(legacy, "w") as zf:
        zf.writestr("confluence-kb.json", json.dumps(
            {"format": "dsh-confluence-kb-base", "version": 1, "source": {"name": "Legacy"}}))
        zf.writestr("kb/dba/x--1.md", "# x\n")
    r = run("unpack", "--archive", str(legacy), "--check", "--json")
    check("the earlier marker still opens", r.returncode == 0 and '"ok": true' in r.stdout, r.stdout[-300:])

    print("case 20: pack refuses an unreadable metadata file")
    broken = WORK / "broken-meta.json"
    broken.write_text("{not json", encoding="utf-8")
    r = run("pack", "--out", str(WORK / "broken.zip"), "--meta", str(broken), "--json")
    check("broken metadata is refused", '"meta-unreadable"' in r.stdout, r.stdout[-300:])

    print("case 21: --version and the registry default source")
    r = subprocess.run([PY, str(KB_PY), "--version"], capture_output=True, text=True, encoding="utf-8")
    check("version is printed", "kb.py 1.0.0" in r.stdout, r.stdout + r.stderr)
    home = WORK / "home-default"
    if home.exists():
        shutil.rmtree(home)
    shutil.copytree(kb_copy, home / "proj")
    (home / "knowledge-sources.json").write_text(json.dumps({
        "version": 2, "defaultId": "proj",
        "sources": [{"id": "proj", "root": str(home / "proj")}],
    }), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "KB_HOME"}
    env["KB_DIR"] = str(home)
    r = subprocess.run([PY, str(KB_PY), "stats"], capture_output=True, text=True,
                       encoding="utf-8", env=env)
    check("the registry default is used without --kb",
          r.returncode == 0 and "articles: 3" in r.stdout, (r.stdout + r.stderr)[-400:])
    empty_home = WORK / "home-empty"
    empty_home.mkdir(exist_ok=True)
    r = subprocess.run([PY, str(KB_PY), "stats"], capture_output=True, text=True,
                       encoding="utf-8",
                       env={**{k: v for k, v in os.environ.items() if k != "KB_HOME"},
                            "KB_DIR": str(empty_home)})
    check("without a registry the engine explains the requirement",
          r.returncode != 0 and "no knowledge base configured" in r.stderr, r.stderr[-300:])

    print()
    if failures:
        print(f"{len(failures)} FAILED: {', '.join(failures)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

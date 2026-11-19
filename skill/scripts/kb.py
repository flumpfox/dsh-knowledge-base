#!/usr/bin/env python3
"""Confluence HTML export -> markdown knowledge base.

Stdlib only. Commands:
  import  --zip FILE [--kb DIR] [--base-url URL] [--spaces KEYS] [--progress] [--dry-run]
  inspect --zip FILE [--json]        validate an archive, list its spaces and pages
  fetch   --url URL --token TOKEN [--spaces KEYS] [--since DATE] [--progress] [--save-zip FILE]
  index   [--kb DIR]
  search  QUERY... [--kb DIR] [-n 10] [--space S] [--status S]
  get     ID [--kb DIR]
  audit   [--kb DIR] [--stale] [--json] [--months N]
  stats   [--kb DIR]
  pack    --out FILE [--meta FILE] [--json]      portable base archive
  unpack  --archive FILE [--check] [--json]      restore a portable base archive

`--progress` prints `PROGRESS <done>/<total> <space>` lines on stderr, one per
page; it is the contract the DSH plugin parses and the tests assert.

The base directory holds:
  INDEX.md              generated table of contents
  MANIFEST.jsonl        one row per imported page (diffing source of truth)
  <space>/<slug>--<id>.md
  attachments/<pageid>/...
  raw/<stamp>/          extracted export (input archive)
  kb.sqlite             search index (derived, rebuildable)
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import posixpath
import re
import shutil
import sqlite3
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath

try:  # Cyrillic output on legacy Windows consoles
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# --------------------------------------------------------------------------
# constants
# --------------------------------------------------------------------------

VERSION = "1.0.0"

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}

# tags whose end may be implied by the next start tag
AUTO_CLOSE = {
    "li": ("li",),
    "p": ("p",),
    "td": ("td", "th"),
    "th": ("td", "th"),
    "tr": ("tr", "td", "th"),
    "option": ("option",),
    "dt": ("dt", "dd"),
    "dd": ("dt", "dd"),
}

# block-level start tags that terminate an open <p>
BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset",
    "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
    "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
}

INLINE_TAGS = {
    "a", "br", "code", "strong", "b", "em", "i", "span", "img", "s", "del",
    "sup", "sub", "mark", "u", "time", "label", "font", "input",
}

NOISE_IDS = {    "breadcrumb-section", "footer", "comments-section", "comment-section",
    "page-metadata", "navigation", "header", "sidebar", "search",
    "action-menu", "editPageLink", "comments", "likes-and-labels",
    "page-history", "content-metadata", "labels-section",
}

NOISE_CLASS_RE = re.compile(
    r"(?<![a-z-])(toc-macro|childpages-macro|breadcrumbs?|page-metadata|"
    r"ia-|aui-header|navigation|footer|comments?-section|hidden|screen-reader-only|"
    r"assistive|editor-inline-comment|inline-comment-marker|"
    r"confluence-anchor-link|anchor-link)(?![a-z-])",
    re.I,
)

# macros that are containers, not documents
SKIP_MACRO_RE = re.compile(
    r"(toc-macro|childpages-macro|children-macro|page-index|recently-updated|"
    r"contentbylabel|blog-posts|popular-labels|spaces-list)", re.I)

INFO_RE = re.compile(r"confluence-information-macro-(note|warning|information|tip|info)", re.I)
INFO_LABEL = {"note": "NOTE", "warning": "WARNING", "information": "NOTE",
              "tip": "TIP", "info": "NOTE"}

DATE_PATTERNS = [
    re.compile(r"(\d{4})-(\d{2})-(\d{2})"),
    re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4})"),
]

RU_MONTHS = {
    "янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5, "июн": 6,
    "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12,
}
EN_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

FM_PRESERVE = ("status", "owner", "review_after", "tags", "notes",
               "supersedes", "superseded_by", "volatile", "pin")

# bump when the search index layout or its text preprocessing changes
FTS_VERSION = 3

SIGNAL_PATTERNS = {
    "ipv4": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    "version": re.compile(r"\b\d+\.\d+(?:\.\d+)?\b"),
    "url": re.compile(r"https?://[^\s)\]]+"),
    "path": re.compile(r"(?<!\w)(?:/(?:etc|var|opt|usr|home|srv)/[\w./-]+)"),
}

SAFE_SCALAR = re.compile(r"^(?![-?:,\[\]{}#&*!|>'\"%@`\s])[^:#\[\]{}\",]*$")
SAFE_KEY = re.compile(r"^[a-z][a-z0-9_]*$")


# --------------------------------------------------------------------------
# machine-readable progress (stderr contract, see --progress)
# --------------------------------------------------------------------------

PROGRESS_PREFIX = "PROGRESS "


class Progress:
    """Emit `PROGRESS <done>/<total> <space>` lines on stderr when enabled.

    The format is part of the CLI contract: the DSH plugin parses exactly these
    lines to drive its progress bar and is covered by tests, so keep the prefix,
    the order of the fields, and one line per page. `total` counts pages: HTML
    files in an archive, the `totalSize` of the CQL page search for `fetch`.

    `total` may be 0 when the server reports no `totalSize`; readers then show
    a count without a percentage instead of inventing a denominator.
    """

    def __init__(self, enabled: bool = False, total: int = 0, space: str = "") -> None:
        self.enabled = bool(enabled)
        self.total = max(int(total or 0), 0)
        self.done = 0
        self.space = space or ""

    def start(self, total: int, space: str = "") -> None:
        self.total = max(int(total or 0), 0)
        self.done = 0
        self.space = space or ""
        self.emit()

    def tick(self, space: str | None = None, done: int | None = None) -> None:
        self.done = int(done) if done is not None else self.done + 1
        if space is not None:
            self.space = space
        self.emit()

    def finish(self) -> None:
        """Close the run: a listing that completed consumed every page it counted."""
        if self.total and self.done != self.total:
            self.done = self.total
            self.emit()

    def emit(self) -> None:
        if not self.enabled:
            return
        line = f"{PROGRESS_PREFIX}{self.done}/{self.total}"
        if self.space:
            line += f" {self.space}"
        print(line, file=sys.stderr, flush=True)


NO_PROGRESS = Progress(False)


# --------------------------------------------------------------------------
# tiny YAML subset (frontmatter only)
# --------------------------------------------------------------------------

def yaml_scalar(v) -> str:
    s = str(v)
    if s == "":
        return '""'
    if SAFE_SCALAR.match(s) and s.lower() not in ("null", "true", "false", "yes", "no", "on", "off"):
        return s
    return json.dumps(s, ensure_ascii=False)


def fm_dump(data: dict) -> str:
    lines = ["---"]
    for k, v in data.items():
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            lines.append(f"{k}: [" + ", ".join(json.dumps(str(x), ensure_ascii=False) for x in v) + "]")
        else:
            lines.append(f"{k}: {yaml_scalar(v)}")
    lines.append("---")
    return "\n".join(lines)


def fm_parse(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    head = text[3:end]
    body = text[end + 4:]
    data = {}
    for line in head.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if not SAFE_KEY.match(k):
            continue
        if v.startswith("["):
            try:
                data[k] = [str(x) for x in json.loads(v)]
            except Exception:
                data[k] = [x.strip().strip('"') for x in v.strip("[]").split(",") if x.strip()]
        elif v.startswith('"'):
            try:
                data[k] = json.loads(v)
            except Exception:
                data[k] = v.strip('"')
        else:
            data[k] = v
    return data, body.lstrip("\n")


# --------------------------------------------------------------------------
# DOM
# --------------------------------------------------------------------------

class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent

    def get(self, name, default=""):
        return self.attrs.get(name) or default

    @property
    def cls(self) -> str:
        return (self.attrs.get("class") or "").strip()

    def __repr__(self):
        return f"<{self.tag} {self.cls or self.get('id')}>"


class DomParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]
        self.open_tags = ["#root"]

    def handle_starttag(self, tag, attrs):
        # HTML allows omitting </li>, </p>, </td>; Confluence exports rely on it.
        # A block element always terminates an open paragraph, and a new list item
        # or table cell terminates the previous one.
        if len(self.stack) > 1 and self.stack[-1].tag == "p" and tag in BLOCK_TAGS:
            self.stack.pop()
        for implied in AUTO_CLOSE.get(tag, ()):
            if len(self.stack) > 1 and self.stack[-1].tag == implied:
                self.stack.pop()
                break
        node = Node(tag, {k: (v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag in VOID:
            return
        self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = Node(tag, {k: (v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse_html(text: str) -> Node:
    p = DomParser()
    p.feed(text)
    p.close()
    return p.root


def find_all(node, pred, limit=100000):
    out, stack = [], [node]
    while stack:
        n = stack.pop()
        if not isinstance(n, str):
            if pred(n):
                out.append(n)
            stack.extend(reversed(n.children))
    return out[:limit]


def find_first(node, pred):
    for n in find_all(node, pred, limit=20000):
        return n
    return None


def text_of(node) -> str:
    parts, stack = [], [node]
    while stack:
        n = stack.pop()
        if isinstance(n, str):
            parts.append(n)
        elif n.tag == "br":
            parts.append("\n")
        else:
            stack.extend(reversed(n.children))
    return "".join(parts)


def has_ancestor(node, tags):
    p = node.parent
    while p is not None:
        if p.tag in tags:
            return True
        p = p.parent
    return False


def to_html(node) -> str:
    if isinstance(node, str):
        return node.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    attrs = "".join(f' {k}="{v}"' for k, v in node.attrs.items() if k not in ("style",))
    inner = "".join(to_html(c) for c in node.children)
    if node.tag in VOID:
        return f"<{node.tag}{attrs}>"
    return f"<{node.tag}{attrs}>{inner}</{node.tag}>"


# --------------------------------------------------------------------------
# renderer: DOM -> markdown
# --------------------------------------------------------------------------

def dedent_block(raw: str) -> str:
    """Remove the common indentation HTML formatting adds to preformatted text."""
    lines = raw.replace("\r\n", "\n").replace("\xa0", " ").split("\n")
    indents = [len(ln) - len(ln.lstrip(" ")) for ln in lines if ln.strip()]
    cut = min(indents) if indents else 0
    return "\n".join(ln[cut:] if ln.strip() else "" for ln in lines)


class Renderer:
    def __init__(self, id_map: dict, page_id: str, attachments: dict, page_rel: str = ""):
        self.id_map = id_map          # source page id -> relative md path
        self.page_id = page_id
        self.page_rel = page_rel      # this article's path inside the KB
        self.attachments = set(attachments)  # absolute-ish member names
        self.used_attachments = set()

    # ---- helpers -------------------------------------------------------
    def is_noise(self, n: Node) -> bool:
        if n.tag in ("script", "style", "noscript", "meta", "link", "head"):
            return True
        if n.get("id").lower() in NOISE_IDS:
            return True
        if SKIP_MACRO_RE.search(n.cls) or SKIP_MACRO_RE.search(n.get("id")):
            return True
        if NOISE_CLASS_RE.search(n.cls):
            return True
        style = n.get("style").replace(" ", "").lower()
        if "display:none" in style:
            return True
        return False

    @staticmethod
    def norm(text: str) -> str:
        return re.sub(r"\s+", " ", text)

    def raw(self, n) -> str:
        return "".join(c if isinstance(c, str) else (c if c.tag != "br" else "\n")
                       for c in [n]) if isinstance(n, str) else text_of(n)

    # ---- inline --------------------------------------------------------
    def inline(self, node) -> str:
        parts = []
        for ch in node.children:
            parts.append(self.inline_node(ch))
        return "".join(parts)

    def inline_node(self, n) -> str:
        if isinstance(n, str):
            return self.norm(n)
        t = n.tag
        if t == "br":
            return "  \n"
        if self.is_noise(n):
            return ""
        if t == "code":
            code = self.norm_preserve(n)
            if not code:
                return ""
            return "`" + code + "`"
        if t in ("strong", "b"):
            inner = self.inline(n).strip()
            return f"**{inner}**" if inner else ""
        if t in ("em", "i"):
            inner = self.inline(n).strip()
            return f"*{inner}*" if inner else ""
        if t in ("del", "s", "strike"):
            inner = self.inline(n).strip()
            return f"~~{inner}~~" if inner else ""
        if t in ("sup", "sub"):
            inner = self.inline(n).strip()
            return f"^{inner}^" if t == "sup" else f"~{inner}~"
        if t == "a":
            return self.link(n)
        if t == "img":
            return self.image(n)
        if t == "input":
            return ""
        if t == "time":
            inner = self.inline(n).strip()
            return inner or n.get("datetime")
        return self.inline(n)

    @staticmethod
    def norm_preserve(n) -> str:
        return text_of(n).strip().replace("\n", " ")

    def link(self, n: Node) -> str:
        text = self.inline(n).strip()
        href = n.get("href").strip()
        cls = n.cls.lower()
        if "confluence-userlink" in cls or "user-mention" in cls:
            return f"@{text}" if text else ""
        if "status-macro" in cls or "aui-lozenge" in cls:
            return f"`{text}`" if text else ""
        if not href or href.startswith("#") or href.lower().startswith("javascript"):
            return text
        target = self.resolve_href(href)
        if not text:
            text = target
        return f"[{text}]({target})"

    def resolve_href(self, href: str) -> str:
        m = re.search(r"pageId=(\d+)", href)
        pid = m.group(1) if m else None
        if not pid:
            m = re.search(r"(?<!\d)(\d{3,})\.html?$", href)
            pid = m.group(1) if m else None
        if pid and pid != self.page_id:
            rel = self.id_map.get(pid)
            if rel:
                return self.rel_link(rel)
            return f"confluence:pageId={pid}"
        if pid == self.page_id:
            return ""
        if href.startswith(("http://", "https://", "mailto:")):
            return href
        if href.startswith("/"):
            # server-side action links (createpage.action, download attachments…)
            # have no local counterpart; mark instead of pretending they resolve
            return "confluence:" + href
        return href

    def rel_link(self, target_rel: str) -> str:
        # links stay correct even when spaces live in different directories
        start = str(PurePosixPath(self.page_rel).parent) if self.page_rel else "."
        try:
            return posixpath.relpath(target_rel, start=start)
        except ValueError:
            return target_rel

    def image(self, n: Node) -> str:
        src = n.get("src").strip()
        alt = self.norm(n.get("alt") or n.get("title") or "").strip()
        if not src:
            return alt
        clean = src.split("?")[0]        # /download/attachments/1/x.png?version=2
        low = clean.lower()
        if "emoticon" in n.cls.lower() or "icons/" in low:
            return alt
        m = re.search(r"(?:^|/)(?:download/)?(?:attachments|thumbnails)/(\d+)/(.+)$", clean, re.I)
        if m:
            pid = m.group(1)
            # Confluence URL-encodes the title in the src ("%3A" for a colon) and
            # the file on disk is the sanitized form of the decoded name.
            raw_name = urllib.parse.unquote(PurePosixPath(m.group(2)).name)
            name = safe_component(raw_name)
            self.used_attachments.add(f"{pid}/{name}")
            return f"![{alt}](../attachments/{pid}/{name})"
        if low.startswith(("http://", "https://")):
            return f"![{alt}]({src})"
        if low.startswith("data:"):
            return f"*[inline image omitted]*"
        return f"![{alt}]({src})"

    # ---- blocks --------------------------------------------------------
    def block(self, node) -> str:
        if isinstance(node, str):
            txt = self.norm(node).strip()
            return txt
        if self.is_noise(node):
            return ""
        t = node.tag

        if t in ("h1", "h2", "h3", "h4", "h5", "h6"):
            inner = self.inline(node).strip()
            return f"{'#' * int(t[1])} {inner}" if inner else ""

        if t == "p":
            inner = self.inline(node).strip()
            return inner

        if t in ("ul", "ol"):
            return self.render_list(node)

        if t == "pre":
            return self.render_pre(node)

        if t == "table":
            return self.render_table(node)

        if t == "blockquote":
            inner = self.blocks(node)
            return "\n".join("> " + ln if ln else ">" for ln in inner.splitlines())

        if t == "hr":
            return "---"

        if t == "img":
            img = self.image(node)
            return img

        if t == "details":
            return self.render_details(node)

        if t == "div" or t == "section" or t == "article" or t == "main":
            return self.render_div(node)

        if t == "a":
            return self.link(node)

        if t in ("span", "code", "strong", "b", "em", "i", "s", "del",
                 "sup", "sub", "time", "label", "button", "font", "u", "mark"):
            inner = self.inline(node).strip()
            return inner

        if t == "iframe":
            src = node.get("src")
            return f"*[embedded: {src}]*" if src else ""

        # unknown element: keep its children
        return self.blocks(node)

    def blocks(self, node) -> str:
        out = []
        for ch in node.children:
            s = self.block(ch)
            if s and s.strip():
                out.append(s.strip("\n"))
        return "\n\n".join(out)

    # ---- div macros ----------------------------------------------------
    def render_div(self, n: Node) -> str:
        cls = n.cls
        # Mermaid diagrams keep their source only in a hidden element; the rendered
        # image needs a licence. Preserving the source text is the only way to keep it.
        if "mermaid" in cls:
            src = find_first(n, lambda x: "mermaid-content" in x.cls)
            raw = dedent_block(text_of(src if src is not None else n).strip("\n"))
            if not raw.strip():
                return ""
            fence = "```"
            while fence in raw:
                fence += "`"
            return f"{fence}mermaid\n{raw}\n{fence}"

        m = INFO_RE.search(cls)
        if m:
            kind = INFO_LABEL.get(m.group(1).lower(), "NOTE")
            title_node = find_first(n, lambda x: "title" in x.cls.split())
            title = self.inline(title_node).strip() if title_node else ""
            body_node = find_first(n, lambda x: "macro-body" in x.cls) or n
            body = self.blocks(body_node)
            label = f"[!{kind}]"
            head = f"> {label}" + (f" {title}" if title else "")
            lines = [head]
            for ln in body.splitlines():
                lines.append("> " + ln if ln.strip() else ">")
            return "\n".join(lines)

        if INFO_RE.search(cls) or "aui-message" in cls:
            body = self.blocks(n)
            return self.to_callout("NOTE", "", body)

        if "expand-container" in cls:
            return self.render_details(n)

        if "code" in cls.split() or "preformatted" in cls:
            pre = find_first(n, lambda x: x.tag == "pre")
            if pre is not None:
                return self.render_pre(pre)

        if "panel" in cls.split():
            title_node = find_first(n, lambda x: "panelHeader" in x.cls or "title" in x.cls.split())
            title = self.inline(title_node).strip() if title_node else ""
            body_node = find_first(n, lambda x: "panelContent" in x.cls) or n
            body = self.blocks(body_node)
            head = f"**{title}**" if title else ""
            return "\n\n".join(x for x in (head, body) if x)

        if "jira-issue" in cls or "jiraissues" in cls:
            return "*[Jira macro not exported]*"

        if "drawio" in cls or "gliffy" in cls:
            body = self.blocks(n)
            return body or "*[diagram macro without preview]*"

        if "include" in cls and "macro" in cls:
            body = self.blocks(n)
            return body

        return self.blocks(n)

    def to_callout(self, kind: str, title: str, body: str) -> str:
        head = f"> [!{kind}]" + (f" {title}" if title else "")
        lines = [head]
        for ln in body.splitlines():
            lines.append("> " + ln if ln.strip() else ">")
        return "\n".join(lines)

    def render_details(self, n: Node) -> str:
        ctrl = find_first(n, lambda x: "expand-control-text" in x.cls or "summary" in x.cls)
        title = self.inline(ctrl).strip() if ctrl else (n.get("data-title") or "Details")
        content = find_first(n, lambda x: "expand-content" in x.cls or x.tag == "details")
        if content is not None and content is not n:
            body = self.blocks(content)
        else:
            body = self.blocks(n)
        if not body.strip():
            return ""
        return f"<details>\n<summary>{title}</summary>\n\n{body}\n\n</details>"

    # ---- lists ---------------------------------------------------------
    def render_list(self, n: Node, depth: int = 0) -> str:
        ordered = n.tag == "ol"
        lines = []
        idx = 1
        for li in n.children:
            if isinstance(li, str):
                continue
            if li.tag != "li":
                continue
            marker = f"{idx}." if ordered else "-"
            idx += 1
            indent = "  " * depth
            prefix = f"{indent}{marker} "
            checkbox = find_first(li, lambda x: x.tag == "input" and x.get("type").lower() == "checkbox")
            checked = False
            if "checked" in li.attrs or (checkbox is not None and "checked" in checkbox.attrs):
                checked = True
            body_parts, nested = [], []
            for ch in li.children:
                if isinstance(ch, str):
                    if ch.strip():
                        body_parts.append(self.norm(ch))
                    continue
                if ch.tag in ("ul", "ol"):
                    nested.append(ch)
                elif ch.tag == "input":
                    continue
                else:
                    s = self.block(ch)
                    if s.strip():
                        body_parts.append(s.strip())
            text = " ".join(body_parts).strip()
            text = re.sub(r"\s+", " ", text)
            if checkbox is not None:
                prefix = f"{indent}- [{'x' if checked else ' '}] "
            if not text and not nested:
                continue
            lines.append(prefix + text)
            for sub in nested:
                sub_md = self.render_list(sub, depth + 1)
                if sub_md.strip():
                    lines.extend(sub_md.splitlines())
        return "\n".join(lines)

    # ---- code ----------------------------------------------------------
    def code_lang(self, pre: Node) -> str:
        params = pre.get("data-syntaxhighlighter-params")
        if params:
            m = re.search(r"brush:\s*([A-Za-z0-9+#-]+)", params)
            if m:
                return m.group(1).lower()
        lang = pre.get("data-code-lang") or pre.get("lang")
        if lang:
            return lang.lower()
        code = find_first(pre, lambda x: x.tag == "code")
        if code is not None:
            m = re.search(r"language-([A-Za-z0-9+#-]+)", code.cls, re.I)
            if m:
                return m.group(1).lower()
        m = re.search(r"(?:syntaxhighlighter|code)-([a-z]{2,12})", pre.cls, re.I)
        if m:
            return m.group(1).lower()
        return ""

    def render_pre(self, n: Node) -> str:
        raw = text_of(n)
        raw = dedent_block(raw.replace("\r\n", "\n").replace("\xa0", " "))
        raw = raw.strip("\n")
        if not raw.strip():
            return ""
        fence = "```"
        while fence in raw:
            fence += "`"
        lang = self.code_lang(n)
        return f"{fence}{lang}\n{raw}\n{fence}"

    # ---- tables --------------------------------------------------------
    def table_rows(self, n: Node):
        rows = []
        for tr in find_all(n, lambda x: x.tag == "tr"):
            if has_ancestor(tr, {"table"}) and tr.parent is not None and tr.parent.parent is not n:
                # nested table row
                if not any(a is n for a in self._ancestors(tr)):
                    continue
            cells = []
            for c in tr.children:
                if isinstance(c, str) or c.tag not in ("td", "th"):
                    continue
                cells.append(c)
            if cells:
                rows.append((tr, cells))
        return rows

    @staticmethod
    def _ancestors(n):
        out, p = [], n.parent
        while p is not None:
            out.append(p)
            p = p.parent
        return out

    def render_table(self, n: Node) -> str:
        rows = self.table_rows(n)
        if not rows:
            return ""
        complex_table = False
        for tr, cells in rows:
            for c in cells:
                if c.get("colspan") not in ("", "1") or c.get("rowspan") not in ("", "1"):
                    complex_table = True
                if find_first(c, lambda x: x.tag in ("table", "pre", "div")):
                    complex_table = True
        if complex_table:
            return to_html(n)

        def cell_text(c: Node) -> str:
            kids = [ch for ch in c.children if not isinstance(ch, str)]
            # A cell holding only inline markup must stay one line, otherwise
            # "code, code, code" turns into a column of <br> fragments.
            if all(k.tag in INLINE_TAGS for k in kids):
                txt = self.inline(c)
            else:
                txt = self.blocks(c)
            txt = txt.replace("|", "\\|")
            txt = re.sub(r"\s*\n+\s*", "<br>", txt.strip())
            return txt

        grid = [[cell_text(c) for c in cells] for _, cells in rows]
        width = max(len(r) for r in grid)
        grid = [r + [""] * (width - len(r)) for r in grid]
        header = grid[0]
        body = grid[1:]
        out = ["| " + " | ".join(header) + " |",
               "| " + " | ".join("---" for _ in header) + " |"]
        for r in body:
            out.append("| " + " | ".join(r) + " |")
        return "\n".join(out)


def read_html_file(path: Path) -> str:
    """Decode an exported page, honouring its declared charset.

    Old exports are windows-1251 more often than one would like, and a wrong
    guess turns every Cyrillic title into replacement characters.
    """
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", "replace")
    probe = raw[:2048].decode("ascii", "ignore").lower()
    m = re.search(r'charset\s*=\s*["\']?([\w-]+)', probe)
    enc = m.group(1) if m else "utf-8"
    try:
        return raw.decode(enc, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


# --------------------------------------------------------------------------
# page discovery / metadata
# --------------------------------------------------------------------------

def meta_content(dom: Node, name: str) -> str:
    for m in find_all(dom, lambda x: x.tag == "meta"):
        if m.get("name").lower() == name.lower():
            return m.get("content").strip()
    return ""


def canonical_url(dom: Node) -> str:
    for link in find_all(dom, lambda x: x.tag == "link" and "canonical" in x.get("rel").lower()):
        href = link.get("href").strip()
        if href:
            return href
    return ""


def content_root(dom: Node):
    for pred in (
        lambda x: x.get("id") == "main-content",
        lambda x: "wiki-content" in x.cls,
        lambda x: x.get("id") == "content",
        lambda x: x.tag == "body",
    ):
        found = find_first(dom, pred)
        if found is not None:
            return found
    return dom


def _iso(y, mo, d) -> str:
    try:
        return dt.date(int(y), int(mo), int(d)).isoformat()
    except (ValueError, TypeError):
        return ""


def parse_date_text(raw: str) -> str:
    """Find a date in the free-form 'last modified' sentence of an export."""
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", raw)
    if m and _iso(*m.groups()):
        return _iso(*m.groups())
    m = re.search(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b", raw)
    if m:
        d, mo, y = m.groups()
        if _iso(y, mo, d):
            return _iso(y, mo, d)
    m = re.search(r"([А-Яа-яЁё]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})", raw)
    if m:
        mo = RU_MONTHS.get(m.group(1).lower()[:3])
        if mo and _iso(m.group(3), mo, m.group(2)):
            return _iso(m.group(3), mo, m.group(2))
    m = re.search(r"([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})", raw)
    if m:
        mo = EN_MONTHS.get(m.group(1).lower()[:3])
        if mo and _iso(m.group(3), mo, m.group(2)):
            return _iso(m.group(3), mo, m.group(2))
    return ""


def find_date(dom: Node) -> str:
    for t in find_all(dom, lambda x: x.tag == "time" and x.get("datetime")):
        found = parse_date_text(t.get("datetime"))
        if found:
            return found
    for node in find_all(dom, lambda x: x.get("id") in ("page-metadata", "content-metadata")
                         or "page-metadata" in x.cls or "last-modified" in x.cls):
        raw = text_of(node)
        lower = raw.lower()
        for marker in ("last modified", "последнее изменение", "изменён", "изменен", "обновлено"):
            idx = lower.find(marker)
            if idx >= 0:
                found = parse_date_text(raw[idx:])
                if found:
                    return found
        found = parse_date_text(raw)
        if found:
            return found
    return ""


def slugify(text: str, limit: int = 70) -> str:
    s = text.lower().replace("ё", "е")
    s = re.sub(r"[^\w\s.-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s_.]+", "-", s).strip("-")
    s = re.sub(r"-{2,}", "-", s)
    return (s[:limit].rstrip("-") or "page")


def space_slug(name: str) -> str:
    s = re.sub(r"[^\w\s.-]", "", (name or "").lower(), flags=re.UNICODE)
    s = re.sub(r"[\s_.]+", "-", s).strip("-")
    return s or "unsorted"


def signal_counts(text: str) -> dict:
    out = {}
    for name, pat in SIGNAL_PATTERNS.items():
        n = len(pat.findall(text))
        if n:
            out[name] = n
    return out


# --------------------------------------------------------------------------
# KB paths
# --------------------------------------------------------------------------

def dsh_home() -> Path:
    """DSH's knowledge-base home: `KB_DIR`, else `~/.dsh/kb`."""
    env = os.environ.get("KB_DIR")
    if env:
        return Path(env)
    home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
    return home / ".dsh" / "kb"


def default_kb() -> Path:
    """The base used when `--kb` is omitted.

    `KB_HOME` wins (tests and scripts use it); otherwise the registry's default
    source; otherwise a clear error instead of a guessed path.
    """
    env = os.environ.get("KB_HOME")
    if env:
        return Path(env)
    home = dsh_home()
    try:
        data = json.loads((home / "knowledge-sources.json").read_text(encoding="utf-8"))
    except Exception:
        data = None
    if isinstance(data, dict):
        default_id = str(data.get("defaultId") or "")
        if default_id:
            for source in data.get("sources") or []:
                if isinstance(source, dict) and str(source.get("id") or "") == default_id:
                    return home / default_id
    raise SystemExit(
        "kb.py: no knowledge base configured. Pass --kb, or create a source in "
        "Settings → Knowledge base."
    )


def kb_layout(kb: Path) -> dict:
    return {
        "kb": kb,
        "index": kb / "INDEX.md",
        "manifest": kb / "MANIFEST.jsonl",
        "db": kb / "kb.sqlite",
        "attachments": kb / "attachments",
        "raw": kb / "raw",
    }


def load_manifest(path: Path) -> dict:
    data = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if row.get("id"):
                data[str(row["id"])] = row
    return data


def write_manifest(path: Path, rows: dict):
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        for rid in sorted(rows, key=lambda x: (rows[x].get("space", ""), rows[x].get("path", ""))):
            f.write(json.dumps(rows[rid], ensure_ascii=False, sort_keys=True) + "\n")
    tmp.replace(path)


# --------------------------------------------------------------------------
# import
# --------------------------------------------------------------------------

# Windows forbids these in a file name; the same characters are unsafe for a
# portable corpus on every platform, so one rule serves both.
UNSAFE_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10)),
}


def safe_component(name: str, fallback: str = "_") -> str:
    """A single path component every supported filesystem accepts.

    Confluence happily keeps `image 21:0:24.png` as an attachment title, and a zip
    made from those pages carries the colon through — `open()` then fails with
    EINVAL on Windows. The same rule is applied when extraction writes a member
    and when a rendered article links to that attachment, so the link and the file
    on disk keep the same spelling.
    """
    cleaned = UNSAFE_NAME_RE.sub("_", str(name)).strip()
    cleaned = cleaned.rstrip(". ")
    if not cleaned:
        return fallback
    stem = cleaned.split(".", 1)[0].lower()
    if stem in RESERVED_NAMES:
        cleaned = "_" + cleaned
    if len(cleaned) > 120:
        head, dot, ext = cleaned.rpartition(".")
        if dot and 0 < len(ext) <= 12:
            cleaned = head[:120 - len(ext) - 1] + "." + ext
        else:
            cleaned = cleaned[:120]
    return cleaned or fallback


def fs_path(path: Path) -> str:
    """An openable path, escaping the 260-character limit on Windows."""
    text = str(path)
    if os.name == "nt" and len(text) > 240 and not text.startswith("\\\\?\\"):
        return "\\\\?\\" + os.path.abspath(text)
    return text


def extract_zip(zip_path: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        members = zf.infolist()
        for m in members:
            name = m.filename
            if name.endswith("/"):
                continue
            # Exports may contain absolute or traversing paths ("/", "../x");
            # keep every entry inside the destination.
            parts = [p for p in PurePosixPath(name.replace("\\", "/")).parts
                     if p not in ("", ".", "..", "/")]
            if not parts:
                continue
            # Attachment titles are not necessarily valid file names; both the
            # archive we generate and an archive a user made may carry them.
            parts = [safe_component(part) for part in parts]
            target = dest.joinpath(*parts)
            if not str(target.resolve()).startswith(str(root)):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(m) as src, open(fs_path(target), "wb") as out:
                shutil.copyfileobj(src, out)
        # remember per-member timestamps for pages without metadata
        stamps = {}
        for m in members:
            if m.filename.lower().endswith(".html"):
                stamps[PurePosixPath(m.filename).name] = dt.datetime(*m.date_time).date().isoformat()
    (dest / ".zipstamps.json").write_text(json.dumps(stamps), encoding="utf-8")
    return dest


def export_root(extracted: Path) -> Path:
    if (extracted / "index.html").exists():
        return extracted
    dirs = [p for p in extracted.iterdir() if p.is_dir()]
    if len(dirs) == 1 and (dirs[0] / "index.html").exists():
        return dirs[0]
    return extracted


def space_from_html(text: str) -> tuple[str, str]:
    """Read the space key and name from one export `index.html` (Key/Name table)."""
    try:
        dom = parse_html(text)
    except Exception:
        return "", ""
    key = name = ""
    for tr in find_all(dom, lambda x: x.tag == "tr"):
        cells = [c for c in tr.children if not isinstance(c, str) and c.tag in ("th", "td")]
        if len(cells) >= 2:
            label = re.sub(r"\s+", " ", text_of(cells[0])).strip().lower()
            value = re.sub(r"\s+", " ", text_of(cells[1])).strip()
            if label == "key":
                key = value
            elif label == "name":
                name = value
    return key, name


def export_space(root: Path) -> tuple[str, str]:
    """Read the space key and name from the export's index.html (Key/Name table)."""
    idx = root / "index.html"
    if not idx.exists():
        return "", ""
    try:
        return space_from_html(read_html_file(idx))
    except Exception:
        return "", ""


def export_space_map(root: Path) -> dict[str, str]:
    """Map every space key in the export to its display name.

    A multi-space export keeps one `index.html` per space folder; the root
    `index.html` describes only the first. Used to accept a space key on the
    command line while articles store the human-readable space name.
    """
    found: dict[str, str] = {}
    try:
        candidates = [root / "index.html", *root.rglob("index.html")]
    except OSError:
        return found
    for idx in candidates:
        if not idx.is_file():
            continue
        try:
            key, name = space_from_html(read_html_file(idx))
        except Exception:
            continue
        if key and key not in found:
            found[key] = name or key
    return found


def cmd_import(args) -> int:
    kb = Path(args.kb).expanduser()
    L = kb_layout(kb)
    zip_path = Path(args.zip)
    if not zip_path.exists():
        print(f"error: no such archive: {zip_path}", file=sys.stderr)
        return 2
    progress = Progress(bool(getattr(args, "progress", False)))

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    digest = hashlib.sha1(zip_path.read_bytes()).hexdigest()[:8]
    raw_dir = L["raw"] / f"{stamp}-{digest}"
    if raw_dir.exists():          # same archive re-imported: start clean
        shutil.rmtree(raw_dir)
    extract_zip(zip_path, raw_dir)
    root = export_root(raw_dir)
    space_key, space_name = export_space(root)
    stamps = {}
    sp = raw_dir / ".zipstamps.json"
    if sp.exists():
        stamps = json.loads(sp.read_text(encoding="utf-8"))

    prev = load_manifest(L["manifest"])
    today = dt.date.today().isoformat()

    html_files = [p for p in root.rglob("*.html")
                  if p.name.lower() not in ("index.html", "toc.html")]
    html_files.sort(key=lambda p: str(p))
    # A page is one HTML file: that is the denominator the progress bar shows.
    progress.start(len(html_files), space_key or space_name)

    pages, skipped = [], []
    for hp in html_files:
        try:
            dom = parse_html(read_html_file(hp))
        except Exception as exc:
            skipped.append((hp.name, f"parse error: {exc}"))
            progress.tick()
            continue
        cr = content_root(dom)
        body_probe = text_of(cr).strip()
        if not body_probe or len(body_probe) < 10:
            skipped.append((hp.name, "no content"))
            progress.tick()
            continue
        pid = meta_content(dom, "ajs-page-id")
        if not pid:
            # "<title>_<id>.html" in newer exports, bare "<id>.html" in older ones
            m = re.search(r"(?<!\d)(\d{3,})\.html?$", hp.name)
            pid = m.group(1) if m else hashlib.sha1(hp.name.encode()).hexdigest()[:10]
        space = (meta_content(dom, "ajs-space-name") or space_name
                 or (root.name if root != raw_dir else "unsorted"))
        progress.tick(space)

        title = ""
        tt = find_first(dom, lambda x: x.get("id") == "title-text")
        if tt is not None:
            title = re.sub(r"\s+", " ", text_of(tt)).strip()
        if not title:
            h1 = find_first(cr, lambda x: x.tag == "h1")
            if h1 is not None:
                title = re.sub(r"\s+", " ", text_of(h1)).strip()
        if not title:
            t = find_first(dom, lambda x: x.tag == "title")
            title = re.sub(r"\s+", " ", text_of(t)).strip() if t else hp.stem
            title = re.split(r"\s+[-–|]\s+", title)[0].strip()
        # the export prefixes page titles with the space name: "Projects : Title"
        for prefix in (space_name, space_key, space):
            if prefix and title.startswith(prefix + " : "):
                title = title[len(prefix) + 3:].strip()
        if not title:
            title = hp.stem
        pages.append({
            "path": hp, "dom": dom, "root": cr, "id": pid, "space": space,
            "title": title or hp.stem,
            "url": canonical_url(dom) or (f"{args.base_url.rstrip('/')}/pages/viewpage.action?pageId={pid}"
                                          if args.base_url else ""),
            # Only a date printed inside the page counts. A zip timestamp is the
            # export date, not the page date, so it is kept separately.
            "source_updated": find_date(dom),
            "zip_stamp": stamps.get(hp.name, ""),
        })

    if not pages:
        print("error: no Confluence pages found in archive", file=sys.stderr)
        return 3

    # `--spaces` narrows what this run writes. Every page found in the archive
    # still counts as present, so pages of unselected spaces are not tombstoned.
    wanted = {s.strip().lower() for s in (getattr(args, "spaces", "") or "").split(",") if s.strip()}
    if wanted:
        key_by_name = {name.lower(): key for key, name in export_space_map(root).items()}
        selected_pages = [p for p in pages
                          if p["space"].lower() in wanted
                          or key_by_name.get(p["space"].lower(), p["space"].lower()).lower() in wanted]
        if not selected_pages:
            print("error: none of the requested spaces are present in the archive", file=sys.stderr)
            return 3
    else:
        selected_pages = pages
    filtered = len(pages) - len(selected_pages)

    # stable relative paths, resolved before rendering (for cross-links)
    id_map = {}
    for p in pages:
        rel = f"{space_slug(p['space'])}/{slugify(p['title'])}--{p['id']}.md"
        p["rel"] = rel
        id_map[p["id"]] = rel

    manifest = dict(prev)
    stats = {"added": 0, "changed": 0, "unchanged": 0, "deprecated": 0,
             "skipped": len(skipped), "filtered": filtered, "duplicates": 0}
    written = []

    # One file per page id. A base accumulates files from several imports, and an
    # id can already sit under another title (an older import, an export that
    # repeats an id). The index has one row per id, so the importer keeps the
    # file it is about to write and removes the stale twin.
    existing_by_id: dict[str, list[Path]] = {}
    for md in iter_articles(kb):
        pid = str(_frontmatter_head(md).get("id") or "")
        if pid:
            existing_by_id.setdefault(pid, []).append(md)
    written_ids: dict[str, Path] = {}

    def drop_stale_twins(pid: str, keep: Path) -> None:
        for other in existing_by_id.get(pid, []):
            if other == keep or not other.exists():
                continue
            try:
                other.unlink()
                stats["duplicates"] += 1
            except OSError:
                pass
        previous = written_ids.get(pid)
        if previous is not None and previous != keep and previous.exists():
            try:
                previous.unlink()
                stats["duplicates"] += 1
            except OSError:
                pass
        written_ids[pid] = keep

    # attachments (copy once) — an archive may hold several space folders
    for att_dir in root.rglob("attachments"):
        if not att_dir.is_dir():
            continue
        for src in att_dir.rglob("*"):
            if not src.is_file():
                continue
            rel = Path("attachments") / src.relative_to(att_dir)
            dst = kb / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                shutil.copy2(src, dst)

    for p in selected_pages:
        renderer = Renderer(id_map, p["id"], set(), p["rel"])
        body = renderer.blocks(p["root"]).strip()
        body = re.sub(r"\n{3,}", "\n\n", body)
        # markdown-macro pages repeat the page title as a leading H1
        head, sep, rest = body.partition("\n")
        if head.startswith("# ") and sep:
            same = re.sub(r"\s+", " ", head[2:]).strip().lower() == \
                   re.sub(r"\s+", " ", p["title"]).strip().lower()
            if same:
                body = rest.lstrip("\n")
        if not body.strip():
            stats["skipped"] += 1
            skipped.append((p["path"].name, "empty after render"))
            continue

        rel = p["rel"]
        out_path = kb / rel
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
        old = prev.get(p["id"])
        old_path = kb / old["path"] if old and old.get("path") else None

        # Keep exactly one file for this page id before writing.
        if not args.dry_run:
            drop_stale_twins(p["id"], out_path)

        # preserve hand-maintained fields from an existing file
        keep = {}
        existing = old_path if old_path and old_path.exists() else (out_path if out_path.exists() else None)
        if existing:
            fm, _ = fm_parse(existing.read_text(encoding="utf-8"))
            for k in FM_PRESERVE:
                if k in fm and fm[k] not in ("", None):
                    keep[k] = fm[k]
            if existing != out_path and old_path and old_path.exists() and old_path != out_path:
                try:
                    old_path.unlink()
                except OSError:
                    pass

        same = old is not None and old.get("hash") == digest and out_path.exists()
        if same:
            # Body unchanged: leave the file alone so hand-written notes survive.
            stats["unchanged"] += 1
            row = dict(old)
            row["title"] = p["title"]
            row["space"] = p["space"]
            row["source_updated"] = p["source_updated"] or old.get("source_updated", "unknown")
            new_url = p["url"] or f"confluence:pageId={p['id']}"
            if old.get("source_url") != new_url:
                # Base URL corrected since the first import: metadata only.
                fm_old, txt = fm_parse(out_path.read_text(encoding="utf-8"))
                fm_old["source_url"] = new_url
                if not args.dry_run:
                    out_path.write_text(fm_dump(fm_old) + "\n\n" + txt, encoding="utf-8")
                row["source_url"] = new_url
            manifest[p["id"]] = row
            continue
        stats["changed" if old else "added"] += 1

        status = keep.get("status") or p.get("status") or "current"
        if status == "deprecated":
            status = "current"
            keep.pop("status", None)

        fm = {
            "id": p["id"],
            "title": p["title"],
            "space": p["space"],
            "source_url": p["url"] or f"confluence:pageId={p['id']}",
            "source_updated": p["source_updated"] or "unknown",
            "ingested": today,
            "status": status,
            "content_hash": digest,
        }
        if keep.get("tags"):
            fm["tags"] = keep["tags"]
        if keep.get("volatile"):
            fm["volatile"] = keep["volatile"]
        elif status != "deprecated":
            fm["review_after"] = keep.get("review_after") or _default_review(p["source_updated"] or today)
        for extra in ("owner", "notes", "supersedes", "superseded_by", "review_after", "pin"):
            if keep.get(extra):
                fm[extra] = keep[extra]

        if not args.dry_run:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(fm_dump(fm) + "\n\n" + body + "\n", encoding="utf-8")
            written.append(rel)

        row = {
            "id": p["id"], "title": p["title"], "space": p["space"], "path": rel,
            "source_url": fm["source_url"], "source_updated": fm["source_updated"],
            "zip_stamp": p.get("zip_stamp", ""),
            "ingested": today, "hash": digest, "status": status,
            "signals": signal_counts(body),
        }
        manifest[p["id"]] = row

    # pages gone from the export: tombstone, never delete
    current_ids = {p["id"] for p in pages}
    for pid, row in prev.items():
        if pid in current_ids:
            continue
        fpath = kb / row.get("path", "")
        if fpath.exists():
            fm, body = fm_parse(fpath.read_text(encoding="utf-8"))
            if fm.get("status") != "deprecated":
                fm["status"] = "deprecated"
                fm["deprecated_on"] = today
                fm["notes"] = "Source page no longer present in the export."
                if not args.dry_run:
                    fpath.write_text(fm_dump(fm) + "\n\n" + body, encoding="utf-8")
                stats["deprecated"] += 1
        if pid in manifest:
            manifest[pid]["status"] = "deprecated"

    if not args.dry_run:
        write_manifest(L["manifest"], manifest)
    _print_report(stats, skipped, kb if not args.dry_run else None)
    if not args.dry_run:
        build_index(kb, manifest)
        build_fts(kb, manifest)
    return 0


def _default_review(baseline: str) -> str:
    """Review date counts from the source page date, not from the import date.

    A two-year-old page must be flagged, not granted a fresh six-month lease.
    """
    try:
        d = dt.date.fromisoformat(baseline)
    except (ValueError, TypeError):
        d = dt.date.today()
    return (d + dt.timedelta(days=180)).isoformat()


def _print_report(stats, skipped, kb):
    print("import summary")
    for k in ("added", "changed", "unchanged", "deprecated", "skipped", "filtered", "duplicates"):
        print(f"  {k:<11}{stats.get(k, 0)}")
    if kb:
        print(f"  kb         {kb}")
    if skipped:
        print("  skipped files:")
        for name, why in skipped[:20]:
            print(f"    - {name}: {why}")
        if len(skipped) > 20:
            print(f"    ... and {len(skipped) - 20} more")


# --------------------------------------------------------------------------
# index / fts
# --------------------------------------------------------------------------

def iter_articles(kb: Path):
    for md in kb.rglob("*.md"):
        if md.name in ("INDEX.md", "README.md"):
            continue
        if "raw" in md.parts or "attachments" in md.parts:
            continue
        yield md


def read_article(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    fm, body = fm_parse(text)
    return fm, body


def _frontmatter_head(md: Path) -> dict:
    """Frontmatter only, without reading the whole article (used to scan a base)."""
    try:
        with md.open("r", encoding="utf-8", errors="replace") as handle:
            head = handle.read(4096)
    except OSError:
        return {}
    fm, _ = fm_parse(head)
    return fm


def _article_mtime(md: Path) -> float:
    try:
        return md.stat().st_mtime
    except OSError:
        return 0.0


def selected_articles(kb: Path, manifest: dict | None = None):
    """One article per page id, plus the files that lost the tie.

    A base can hold files from several imports, and a page id can end up on two
    files (an older import with another title, an export that repeats an id, a
    hand-added copy). The index has one row per id, so it must choose: the file
    the manifest points at, otherwise the newest one. Everything else is reported
    instead of crashing the whole import on a UNIQUE constraint.
    """
    preferred = {str(pid): str(row.get("path") or "")
                 for pid, row in (manifest or {}).items() if isinstance(row, dict)}
    candidates: dict[str, list[tuple[float, Path, dict, str]]] = {}
    for md in iter_articles(kb):
        fm = _frontmatter_head(md)
        pid = str(fm.get("id") or "")
        if not pid:
            continue
        rel = md.relative_to(kb).as_posix()
        candidates.setdefault(pid, []).append((_article_mtime(md), md, fm, rel))

    chosen, duplicates = [], []
    for pid, entries in candidates.items():
        if len(entries) == 1:
            chosen.append((pid, entries[0][1], entries[0][2], entries[0][3]))
            continue
        wanted = preferred.get(pid, "")
        entries.sort(key=lambda entry: (entry[3] == wanted, entry[0]), reverse=True)
        keep = entries[0]
        chosen.append((pid, keep[1], keep[2], keep[3]))
        duplicates.extend((pid, entry[3]) for entry in entries[1:])
    return chosen, duplicates


def build_index(kb: Path, manifest: dict | None = None):
    L = kb_layout(kb)
    manifest = manifest if manifest is not None else load_manifest(L["manifest"])
    selected, duplicates = selected_articles(kb, manifest)
    by_space = {}
    for _pid, md, fm, rel in selected:
        space = fm.get("space") or "unsorted"
        by_space.setdefault(space, []).append((fm, rel))
    for space in by_space:
        by_space[space].sort(key=lambda x: x[0].get("title", "").lower())

    def is_stale(fm):
        ra = fm.get("review_after") or ""
        return bool(ra) and ra < dt.date.today().isoformat()

    total = sum(len(v) for v in by_space.values())
    stale = sum(1 for v in by_space.values() for fm, _ in v if is_stale(fm) or fm.get("status") == "deprecated")
    lines = [
        "# Knowledge base index",
        "",
        f"Pages: **{total}** · spaces: **{len(by_space)}** · stale/deprecated: **{stale}** · "
        f"generated: {dt.date.today().isoformat()}",
        "",
        "Read the header of every article before trusting it: `source_updated`, `status`, "
        "`review_after`. Volatile facts older than ~6 months must be re-verified.",
        "",
    ]
    for space in sorted(by_space):
        items = by_space[space]
        lines.append(f"## {space} ({len(items)})")
        lines.append("")
        for fm, rel in items:
            flags = []
            if fm.get("status") == "deprecated":
                flags.append("DEPRECATED")
            elif is_stale(fm):
                flags.append("review")
            upd = fm.get("source_updated", "")
            if upd and upd != "unknown":
                flags.append(upd[:7])
            suffix = f" — {', '.join(flags)}" if flags else ""
            anchor = rel
            lines.append(f"- [{fm.get('title', '')}]({anchor}){suffix}")
        lines.append("")
    L["index"].write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_fts(kb: Path, manifest: dict | None = None):
    L = kb_layout(kb)
    db = L["db"]
    if db.exists():
        db.unlink()
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE meta(
            id TEXT PRIMARY KEY, title TEXT, space TEXT, path TEXT,
            source_updated TEXT, status TEXT, review_after TEXT, tags TEXT);
        CREATE VIRTUAL TABLE fts USING fts5(
            id UNINDEXED, title, body, tokenize="unicode61 remove_diacritics 2", prefix="2 3 4");
        """
    )
    rows, fts_rows = [], []
    selected, duplicates = selected_articles(kb, manifest)
    for pid, md, fm, rel in selected:
        _fm, body = read_article(md)
        rows.append((pid, fm.get("title", ""), fm.get("space", ""), rel,
                     fm.get("source_updated", ""), fm.get("status", ""),
                     fm.get("review_after", ""), ",".join(_as_list(fm.get("tags")))))
        fts_rows.append((pid, fm.get("title", ""), fts_clean(body)))
    if duplicates:
        preview = ", ".join(f"{pid} ({rel})" for pid, rel in duplicates[:5])
        print(f"warning: {len(duplicates)} article file(s) repeat a page id and are not indexed: "
              f"{preview}{' …' if len(duplicates) > 5 else ''}", file=sys.stderr)
    con.executemany("INSERT INTO meta VALUES(?,?,?,?,?,?,?,?)", rows)
    con.executemany("INSERT INTO fts(id,title,body) VALUES(?,?,?)", fts_rows)
    con.execute(f"PRAGMA user_version = {FTS_VERSION}")
    con.commit()
    con.close()
    return len(rows)


def _as_list(v):
    if not v:
        return []
    if isinstance(v, list):
        return v
    return [x.strip() for x in str(v).split(",") if x.strip()]


def fts_clean(markdown: str) -> str:
    """Strip markdown syntax for the search index so snippets read as prose."""
    s = markdown
    s = re.sub(r"```[^\n]*\n(.*?)```", lambda m: m.group(1), s, flags=re.S)
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$", " ", s, flags=re.M)
    s = s.replace("|", " ")
    s = re.sub(r"^\s*#{1,6}\s*", "", s, flags=re.M)
    s = re.sub(r"^\s*>\s?", "", s, flags=re.M)
    s = re.sub(r"\[![A-Z]+\]\s*", "", s)
    s = re.sub(r"</?[a-zA-Z][^>]*>", " ", s)
    s = re.sub(r"\*\*|__|~~", "", s)
    s = s.replace("`", "")
    s = re.sub(r"^\s*[-*+]\s+\[[ xX]\]\s*", "", s, flags=re.M)
    s = re.sub(r"[ \t]+", " ", s)
    return s


def ensure_fts(kb: Path) -> Path:
    L = kb_layout(kb)
    db = L["db"]
    newest = 0.0
    for md in iter_articles(kb):
        newest = max(newest, md.stat().st_mtime)
    stale = not db.exists() or db.stat().st_mtime < newest
    if not stale:
        try:
            con = sqlite3.connect(db)
            ver = con.execute("PRAGMA user_version").fetchone()[0]
            con.close()
            stale = ver != FTS_VERSION
        except sqlite3.DatabaseError:
            stale = True
    if stale:
        build_fts(kb)
    return db


# --------------------------------------------------------------------------
# search / get / audit / stats
# --------------------------------------------------------------------------

def cmd_search(args) -> int:
    kb = Path(args.kb).expanduser()
    if not kb.exists():
        print(f"error: no KB at {kb}", file=sys.stderr)
        return 2
    db = ensure_fts(kb)
    terms = [t for t in re.findall(r"[\w-]+", " ".join(args.query), re.UNICODE) if len(t) > 1]
    if not terms:
        print("error: empty query", file=sys.stderr)
        return 2
    match = " AND ".join(f'"{t}"*' for t in terms)
    sql = ("SELECT m.id, m.title, m.space, m.path, m.source_updated, m.status, m.review_after,"
           " snippet(fts, 2, '«', '»', ' … ', 18) AS snip"
           " FROM fts JOIN meta m ON m.id = fts.id WHERE fts MATCH ?")
    params = [match]
    if args.space:
        sql += " AND m.space LIKE ?"
        params.append(f"%{args.space}%")
    if args.status:
        sql += " AND m.status = ?"
        params.append(args.status)
    sql += " ORDER BY bm25(fts, 8.0, 1.0) LIMIT ?"
    params.append(args.n)
    con = sqlite3.connect(db)
    try:
        rows = con.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        rows = []
    con.close()
    if not rows:
        print("no matches")
        return 0
    for rid, title, space, path, upd, status, review, snip in rows:
        flags = []
        if status and status != "current":
            flags.append(status.upper())
        if review and review < dt.date.today().isoformat():
            flags.append("review-due")
        flag = f" [{' ✕ '.join(flags)}]" if flags else ""
        print(f"\n{title}  ({space}){flag}")
        print(f"  id={rid}  updated={upd or '?'}  file={path}")
        snip = re.sub(r"\s+", " ", snip or "").strip()
        print(f"  {snip}")
    print()
    return 0


def cmd_get(args) -> int:
    kb = Path(args.kb).expanduser()
    db = ensure_fts(kb)
    con = sqlite3.connect(db)
    row = con.execute("SELECT path FROM meta WHERE id = ? OR title LIKE ? LIMIT 1",
                      (args.id, f"%{args.id}%")).fetchone()
    con.close()
    if not row:
        print(f"error: no article matching {args.id!r}", file=sys.stderr)
        return 2
    path = kb / row[0]
    print(path.read_text(encoding="utf-8"))
    return 0


def cmd_audit(args) -> int:
    kb = Path(args.kb).expanduser()
    manifest = load_manifest(kb_layout(kb)["manifest"])
    today = dt.date.today()
    cutoff = today - dt.timedelta(days=30 * args.months)
    items = []
    for md in iter_articles(kb):
        fm, body = read_article(md)
        if not fm.get("id"):
            continue
        reasons = []
        if fm.get("status") == "deprecated":
            reasons.append("deprecated")
        ra = fm.get("review_after") or ""
        if ra and ra < today.isoformat():
            reasons.append(f"review_after {ra}")
        upd = fm.get("source_updated") or ""
        if upd and upd != "unknown":
            try:
                if dt.date.fromisoformat(upd) < cutoff:
                    reasons.append(f"source older than {args.months} months")
            except ValueError:
                pass
        else:
            reasons.append("source date unknown")
        sig = (manifest.get(fm["id"]) or {}).get("signals") or signal_counts(body)
        if sig:
            reasons.append("signals: " + ", ".join(f"{k}={v}" for k, v in sorted(sig.items())))
        if reasons:
            items.append({
                "id": fm["id"], "title": fm.get("title", ""), "space": fm.get("space", ""),
                "path": md.relative_to(kb).as_posix(), "updated": upd or None,
                "status": fm.get("status"), "reasons": reasons,
            })
    items.sort(key=lambda x: (x["status"] != "deprecated", x["updated"] or "0000"))
    if args.json:
        print(json.dumps(items, ensure_ascii=False, indent=2))
        return 0
    print(f"{len(items)} article(s) need attention\n")
    for it in items:
        print(f"{it['title']}  ({it['space']})  [{it['updated'] or '?'}]")
        print(f"  {it['path']}")
        print(f"  {', '.join(it['reasons'])}")
    return 0


def cmd_stats(args) -> int:
    kb = Path(args.kb).expanduser()
    L = kb_layout(kb)
    manifest = load_manifest(L["manifest"])
    selected, duplicates = selected_articles(kb, manifest)
    by_status, by_space = {}, {}
    for _pid, _md, fm, _rel in selected:
        status = fm.get("status") or "?"
        by_status[status] = by_status.get(status, 0) + 1
        space = fm.get("space") or "?"
        by_space[space] = by_space.get(space, 0) + 1
    print(f"kb: {kb}")
    print(f"articles: {sum(by_status.values())}   manifest rows: {len(manifest)}")
    print("status: " + ", ".join(f"{k}={v}" for k, v in sorted(by_status.items())))
    print("spaces: " + ", ".join(f"{k}={v}" for k, v in sorted(by_space.items())))
    if duplicates:
        print(f"duplicates: {len(duplicates)} file(s) repeat a page id and are not indexed "
              f"(the next import removes them)")
    print(f"index: {'yes' if L['index'].exists() else 'no'}   db: {'yes' if L['db'].exists() else 'no'}")
    return 0


# --------------------------------------------------------------------------
# portable base archives
# --------------------------------------------------------------------------

BASE_FORMAT = "dsh-knowledge-base-base"
LEGACY_BASE_FORMAT = "dsh-confluence-kb-base"
BASE_FORMAT_VERSION = 1
BASE_ARCHIVE_META = "knowledge-base.json"
LEGACY_BASE_ARCHIVE_META = "confluence-kb.json"
BASE_ARCHIVE_PREFIX = "kb/"


def _is_article_rel(rel: PurePosixPath) -> bool:
    """A corpus article, not the index and not a `.md` attachment.

    Attachments are carried by the archive like any other file, but a page that
    happens to attach a markdown file must not inflate the article count.
    """
    if not rel.parts or rel.parts[0] == "attachments":
        return False
    return rel.name.endswith(".md") and rel.name not in ("INDEX.md", "README.md")


def _is_article_member(name: str) -> bool:
    """The same rule for an archive member written as `kb/<path>`."""
    if not name.startswith(BASE_ARCHIVE_PREFIX):
        return False
    rel = PurePosixPath(name[len(BASE_ARCHIVE_PREFIX):])
    return _is_article_rel(rel)


def _archive_skip(rel: PurePosixPath) -> bool:
    """Files that are not part of the corpus a base can be moved with."""
    if not rel.parts:
        return True
    if rel.parts[0] == "raw":          # extracted export, recreated by an import
        return True
    return rel.as_posix() == "connection.json"  # v1 single-connection state


def _archive_entries(kb: Path):
    """Every file the archive carries, with `raw/` and v1 state pruned early.

    Pruning during the walk matters: `raw/` holds the extracted input archive and
    can be many gigabytes, so enumerating it first would delay the first progress
    line by seconds for nothing.
    """
    for root, dirs, files in os.walk(kb):
        here = Path(root)
        rel_root = here.relative_to(kb)
        if not rel_root.parts:
            dirs[:] = [name for name in dirs if name != "raw"]
        dirs.sort()
        for name in sorted(files):
            path = here / name
            rel = PurePosixPath(*path.relative_to(kb).parts)
            if _archive_skip(rel):
                continue
            yield path, rel


def cmd_pack(args) -> int:
    kb = Path(args.kb).expanduser()
    out = Path(args.out).expanduser()
    meta: dict = {}
    if args.meta:
        try:
            meta = json.loads(Path(args.meta).read_text(encoding="utf-8"))
        except Exception as exc:
            print(json.dumps({"ok": False, "code": "meta-unreadable", "detail": str(exc)}))
            return 2
        if not isinstance(meta, dict):
            print(json.dumps({"ok": False, "code": "meta-invalid"}))
            return 2
    if not kb.is_dir():
        print(json.dumps({"ok": False, "code": "kb-missing", "path": str(kb)}))
        return 2
    payload = {
        "format": BASE_FORMAT,
        "version": BASE_FORMAT_VERSION,
        "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": meta,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    files = 0
    articles = 0
    entries = list(_archive_entries(kb))
    meta_text = json.dumps(payload, ensure_ascii=False, indent=2)
    total = len(meta_text.encode("utf-8")) + sum(path.stat().st_size for path, _rel in entries)
    done = 0

    def report(value: int) -> None:
        if args.progress:
            print(f"PACK {value}/{total}", file=sys.stderr, flush=True)

    try:
        report(0)
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            zf.writestr(BASE_ARCHIVE_META, meta_text)
            done += len(meta_text.encode("utf-8"))
            for path, rel in entries:
                zf.write(path, BASE_ARCHIVE_PREFIX + rel.as_posix())
                done += path.stat().st_size
                files += 1
                if _is_article_rel(rel):
                    articles += 1
                report(done)
        tmp.replace(out)
    except Exception as exc:
        try:
            tmp.unlink()
        except Exception:
            pass
        print(json.dumps({"ok": False, "code": "pack-failed", "detail": str(exc)[:300]}))
        return 2
    if args.json:
        print(json.dumps({
            "ok": True, "path": str(out), "bytes": out.stat().st_size,
            "files": files, "articles": articles,
        }, ensure_ascii=False))
    else:
        print(f"packed {files} file(s), {articles} article(s) -> {out} ({out.stat().st_size} bytes)")
    return 0


def _safe_member(name: str) -> bool:
    """Only relative `kb/...` paths; no absolute paths, drive letters or `..`."""
    if not name or name.startswith("/") or "\\" in name:
        return False
    rel = PurePosixPath(name)
    if any(part in ("..", "") for part in rel.parts):
        return False
    if ":" in rel.parts[0]:
        return False
    return True


def _read_archive_meta(zf: zipfile.ZipFile) -> dict:
    names = zf.namelist()
    meta_name = BASE_ARCHIVE_META if BASE_ARCHIVE_META in names else LEGACY_BASE_ARCHIVE_META
    if meta_name not in names:
        raise ValueError("archive-meta-missing")
    payload = json.loads(zf.read(meta_name).decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("format") not in (BASE_FORMAT, LEGACY_BASE_FORMAT):
        raise ValueError("archive-format")
    if payload.get("version") != BASE_FORMAT_VERSION:
        raise ValueError("archive-version")
    source = payload.get("source")
    if source is not None and not isinstance(source, dict):
        raise ValueError("archive-meta-invalid")
    return payload


def cmd_unpack(args) -> int:
    archive = Path(args.archive).expanduser()
    if not archive.is_file():
        print(json.dumps({"ok": False, "code": "archive-missing", "path": str(archive)}))
        return 2
    try:
        zf = zipfile.ZipFile(archive)
    except zipfile.BadZipFile:
        print(json.dumps({"ok": False, "code": "archive-invalid"}))
        return 2
    with zf:
        try:
            payload = _read_archive_meta(zf)
        except ValueError as exc:
            print(json.dumps({"ok": False, "code": str(exc)}))
            return 2
        names = zf.namelist()
        if not any(name.startswith(BASE_ARCHIVE_PREFIX) for name in names):
            print(json.dumps({"ok": False, "code": "archive-empty"}))
            return 2
        unsafe = [name for name in names if not _safe_member(name)]
        if unsafe:
            print(json.dumps({"ok": False, "code": "archive-unsafe", "detail": unsafe[0]}))
            return 2
        members = [name for name in names if name.startswith(BASE_ARCHIVE_PREFIX)]
        articles = sum(1 for name in members if _is_article_member(name))
        summary = {
            "ok": True,
            "path": str(archive),
            "bytes": archive.stat().st_size,
            "files": len(members),
            "articles": articles,
            "source": payload.get("source") or {},
            "exported_at": payload.get("exported_at") or "",
        }
        if args.check:
            print(json.dumps(summary, ensure_ascii=False))
            return 0
        kb = Path(args.kb).expanduser()
        try:
            kb.mkdir(parents=True, exist_ok=True)
            for name in members:
                rel = PurePosixPath(name).relative_to(BASE_ARCHIVE_PREFIX.rstrip("/"))
                target = kb.joinpath(*rel.parts)
                if name.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(name) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        except Exception as exc:
            print(json.dumps({"ok": False, "code": "unpack-failed",
                              "detail": str(exc)[:300], "kb": str(kb)}))
            return 2
        print(json.dumps({**summary, "kb": str(kb)}, ensure_ascii=False))
        return 0


# --------------------------------------------------------------------------
# REST API import (Confluence Server / Data Center, incl. 8.x)
# --------------------------------------------------------------------------

class ConfluenceError(RuntimeError):
    pass


def _auth_headers(token: str, user: str, password: str) -> dict:
    headers = {"Accept": "application/json", "User-Agent": "dsh-knowledge-base/1.0"}
    if token:
        headers["Authorization"] = "Bearer " + token
    elif user:
        raw = f"{user}:{password}".encode("utf-8")
        headers["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
    return headers


def _http(url: str, headers: dict, insecure: bool = False, retries: int = 3) -> bytes:
    ctx = ssl._create_unverified_context() if insecure else ssl.create_default_context()
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=90, context=ctx) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read()[:300].decode("utf-8", "replace")
            except Exception:
                pass
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                last = exc
                continue
            if exc.code == 401:
                raise ConfluenceError(
                    "401 Unauthorized: check the token (a Personal Access Token needs "
                    "'Authorization: Bearer', not a cookie) and that it has not expired") from None
            if exc.code == 403:
                raise ConfluenceError(f"403 Forbidden for {url}: the token's user cannot see this") from None
            raise ConfluenceError(f"HTTP {exc.code} for {url}: {body}") from None
        except urllib.error.URLError as exc:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                last = exc
                continue
            raise ConfluenceError(f"cannot reach {url}: {exc.reason}") from None
    raise ConfluenceError(f"giving up on {url}: {last}")


def _api_json(base: str, path: str, headers: dict, params: dict | None, insecure: bool) -> dict:
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    raw = _http(url, headers, insecure)
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise ConfluenceError(f"expected JSON from {url}, got {raw[:120]!r}") from None


def _paged(base: str, path: str, headers: dict, params: dict, insecure: bool, limit: int = 50):
    """Walk a start/limit listing.

    Servers differ in how they signal the end: some return fewer rows than
    asked for, some keep repeating the last page. Stopping on an empty page
    and on a page of already-seen ids covers both.
    """
    start = 0
    seen: set[str] = set()
    while True:
        page_params = dict(params)
        page_params.update({"start": start, "limit": limit})
        data = _api_json(base, path, headers, page_params, insecure)
        batch = data.get("results") or []
        if not batch:
            return
        fresh = []
        for row in batch:
            key = str(row.get("id") or row.get("key") or "")
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            fresh.append(row)
        if not fresh:
            return
        for row in fresh:
            yield row
        start += len(batch)
        if start > 200000:
            return


def api_spaces(base: str, headers: dict, space_types: list[str], insecure: bool) -> list[dict]:
    """Every space the token can read, paginated with start/limit (Data Center style)."""
    found: dict[str, dict] = {}
    for stype in space_types:
        for row in _paged(base, "/rest/api/space", headers, {"type": stype}, insecure, limit=100):
            key = row.get("key")
            if key and key not in found:
                found[key] = {"key": key, "name": row.get("name") or key, "type": stype}
    return list(found.values())


def api_pages(base: str, headers: dict, space_key: str, since: str, insecure: bool):
    """Yield current pages of one space, with rendered HTML (body.view)."""
    expand = "version,space,body.view"
    if since:
        cql = f'type=page and space="{space_key}" and lastmodified > "{since}"'
        yield from _paged(base, "/rest/api/content/search", headers,
                          {"cql": cql, "expand": expand}, insecure)
    else:
        yield from _paged(base, "/rest/api/content", headers,
                          {"spaceKey": space_key, "type": "page", "status": "current",
                           "expand": expand}, insecure)


def api_attachments(base: str, headers: dict, page_id: str, insecure: bool) -> list[dict]:
    data = _api_json(base, f"/rest/api/content/{page_id}/child/attachment", headers,
                     {"limit": 200, "expand": "version"}, insecure)
    return data.get("results") or []


def _space_folder(key: str) -> str:
    folder = re.sub(r"[^A-Za-z0-9._-]", "_", key or "SPACE")
    return folder or "SPACE"


def _space_index_html(key: str, name: str) -> str:
    esc = lambda s: (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>{esc(key)} ({esc(name)})</title></head>
<body><div id="main-content" class="pageSection">
<table class="confluenceTable">
<tr><th class="confluenceTh">Key</th><td class="confluenceTd">{esc(key)}</td></tr>
<tr><th class="confluenceTh">Name</th><td class="confluenceTd">{esc(name)}</td></tr>
</table></div></body></html>"""


def _page_html(page: dict, space_name: str, base: str) -> str:
    pid = str(page.get("id"))
    title = page.get("title") or pid
    version = page.get("version") or {}
    when = (version.get("when") or "")[:10]
    body = ((page.get("body") or {}).get("view") or {}).get("value") or ""
    esc = lambda s: (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    meta = f'<span class="last-modified">Last modified on {when}</span>' if when else ""
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="ajs-page-id" content="{pid}">
<meta name="ajs-space-name" content="{esc(space_name)}">
<title>{esc(space_name)} : {esc(title)}</title>
<link rel="canonical" href="{base}/pages/viewpage.action?pageId={pid}">
</head><body>
<div class="page-metadata">{meta}</div>
<div id="main-content" class="wiki-content group">
{body}
</div></body></html>"""


def _reported_total(data: dict) -> int:
    try:
        return max(int(data.get("totalSize") or 0), 0)
    except (TypeError, ValueError):
        return 0


def api_total(base: str, headers: dict, space_key: str, since: str, insecure: bool) -> int:
    """Page count the fetcher will walk for one space (one cheap request).

    Confluence reports the count as `totalSize`, but only the CQL search endpoint
    is guaranteed to carry it: Confluence Server answers `/rest/api/content`
    without the field, so a full import used to show processed pages and no
    denominator. Ask the search endpoint first — with the `since` clause when one
    applies — and keep the plain listing as a fallback for installations whose
    search API is restricted. A server that reports neither yields 0, which
    readers must treat as "unknown total" rather than "nothing to do".
    """
    cql = f'type=page and space="{space_key}"'
    if since:
        cql += f' and lastmodified > "{since}"'
    try:
        total = _reported_total(_api_json(base, "/rest/api/content/search", headers,
                                          {"cql": cql, "limit": 1}, insecure))
        if total:
            return total
    except ConfluenceError:
        pass
    if since:
        return 0
    try:
        return _reported_total(_api_json(base, "/rest/api/content", headers,
                                         {"spaceKey": space_key, "type": "page",
                                          "status": "current", "limit": 1}, insecure))
    except ConfluenceError:
        return 0


def _quote_url(url: str) -> str:
    """Percent-encode characters a server or an export left raw in a URL path.

    Attachment titles end up in `_links.download` verbatim on some deployments
    ("image 21:0:24.png"), and `http.client` refuses a URL with a raw space.
    """
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    path = urllib.parse.quote(parts.path, safe="/%:@!$&'()*+,;=~-._")
    query = urllib.parse.quote(parts.query, safe="=&%:@!$'()*+,;~-._/?")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def build_export_from_api(args, base: str, headers: dict, spaces: list[dict], out_path: Path,
                          progress: Progress = NO_PROGRESS) -> dict:
    """Write an export-shaped zip so the same importer handles API and file input."""
    stats = {"pages": 0, "attachments": 0, "bytes": 0, "empty": 0}
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for sp in spaces:
            key, name = sp["key"], sp["name"]
            folder = _space_folder(key)
            zf.writestr(f"{folder}/index.html", _space_index_html(key, name))
            print(f"  space {key} ({name})…", file=sys.stderr)
            for page in api_pages(base, headers, key, args.since, args.insecure):
                pid = str(page.get("id"))
                progress.tick(key)
                view = ((page.get("body") or {}).get("view") or {}).get("value") or ""
                if not view.strip():
                    stats["empty"] += 1
                    continue
                zf.writestr(f"{folder}/{pid}.html", _page_html(page, name, base))
                stats["pages"] += 1
                if stats["pages"] % 25 == 0:
                    print(f"    {stats['pages']} pages…", file=sys.stderr)
                if args.no_attachments:
                    continue
                for att in api_attachments(base, headers, pid, args.insecure):
                    fname = att.get("title") or ""
                    link = (att.get("_links") or {}).get("download") or ""
                    if not fname or not link:
                        continue
                    # A page title may contain ':' or '"'; the archive we build
                    # must be extractable on Windows.
                    fname = safe_component(fname)
                    if link.startswith("http"):
                        att_url = link
                    else:
                        att_url = base + link
                    att_url = _quote_url(att_url)
                    try:
                        blob = _http(att_url, headers, args.insecure)
                    except ConfluenceError as exc:
                        print(f"    attachment {fname} skipped: {exc}", file=sys.stderr)
                        continue
                    zf.writestr(f"{folder}/attachments/{pid}/{fname}", blob)
                    stats["attachments"] += 1
                    stats["bytes"] += len(blob)
    return stats


def cmd_fetch(args) -> int:
    base = (args.url or "").rstrip("/")
    if not base:
        print("error: --url is required (e.g. https://confluence.example.local)", file=sys.stderr)
        return 2
    token = args.token or os.environ.get("CONFLUENCE_TOKEN", "")
    password = args.password or os.environ.get("CONFLUENCE_PASSWORD", "")
    if not token and not args.user:
        print("error: pass --token (Personal Access Token) or --user/--password,\n"
              "       or set CONFLUENCE_TOKEN / CONFLUENCE_PASSWORD", file=sys.stderr)
        return 2
    headers = _auth_headers(token, args.user, password)

    try:
        types = ["global", "personal"] if args.space_type == "all" else [args.space_type]
        spaces = api_spaces(base, headers, types, args.insecure)
    except ConfluenceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if not spaces:
        print("error: the token sees no spaces", file=sys.stderr)
        return 2

    if args.spaces:
        wanted = {s.strip().lower() for s in args.spaces.split(",") if s.strip()}
        spaces = [s for s in spaces if s["key"].lower() in wanted or s["name"].lower() in wanted]
        if not spaces:
            print("error: none of the requested spaces are visible to this token", file=sys.stderr)
            return 2

    if args.list_spaces:
        for sp in spaces:
            print(f"{sp['key']}\t{sp['name']}")
        return 0

    print(f"spaces to import: {len(spaces)}", file=sys.stderr)
    for sp in spaces:
        print(f"  {sp['key']:<12} {sp['name']}", file=sys.stderr)

    progress = Progress(bool(getattr(args, "progress", False)))
    totals = {sp["key"]: api_total(base, headers, sp["key"], args.since, args.insecure)
              for sp in spaces}
    progress.start(sum(totals.values()), spaces[0]["key"] if spaces else "")

    tmp_path = None
    if args.save_zip:
        out_zip = Path(args.save_zip)
        out_zip.parent.mkdir(parents=True, exist_ok=True)
    else:
        fd, name = tempfile.mkstemp(suffix=".zip", prefix="confluence-fetch-")
        os.close(fd)
        tmp_path = Path(name)
        out_zip = tmp_path

    try:
        stats = build_export_from_api(args, base, headers, spaces, out_zip, progress)
        progress.finish()
        print(f"fetched: {stats['pages']} pages, {stats['attachments']} attachments "
              f"({stats['bytes'] / 1e6:.1f} MB), {stats['empty']} empty pages skipped",
              file=sys.stderr)
        ns = argparse.Namespace(zip=str(out_zip), base_url=base, kb=args.kb, dry_run=args.dry_run,
                                progress=False, spaces="")
        return cmd_import(ns)
    except ConfluenceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass


# --------------------------------------------------------------------------
# inspect (archive validation without importing)
# --------------------------------------------------------------------------

SPACE_META_RE = re.compile(
    r'<meta[^>]+name=["\']ajs-space-name["\'][^>]*content=["\']([^"\']*)', re.I)


def cmd_inspect(args) -> int:
    """Report what an export archive holds without touching a knowledge base.

    Backs the settings page's "check file" action: the same checks the importer
    makes (exists, non-empty, a real zip, page HTML inside), plus per-space page
    counts so the space picker can offer the archive's own spaces. `--json` is
    the machine-readable form; failures carry a stable `code` the UI localizes.
    """
    path = Path(args.zip).expanduser()
    payload: dict = {"ok": False, "path": str(path)}

    def fail(code: str, message: str) -> int:
        payload.update({"ok": False, "code": code, "message": message})
        if args.json:
            print(json.dumps(payload, ensure_ascii=False), flush=True)
        else:
            print(f"error: {message}", file=sys.stderr)
        return 2

    if not path.exists() or not path.is_file():
        return fail("file-missing", f"no such file: {path}")
    try:
        size = path.stat().st_size
    except OSError as exc:
        return fail("file-unreadable", f"cannot read {path}: {exc}")
    payload["bytes"] = size
    if size == 0:
        return fail("file-empty", f"file is empty: {path}")
    if not zipfile.is_zipfile(path):
        return fail("file-not-zip", f"not a zip archive: {path}")

    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            html = [n for n in names if n.lower().endswith((".html", ".htm"))]
            pages = [n for n in html
                     if PurePosixPath(n).name.lower() not in ("index.html", "toc.html")]
            if not pages:
                return fail("file-no-pages", "archive contains no page HTML files")

            spaces: dict[str, dict] = {}
            for n in names:
                if PurePosixPath(n).name != "index.html":
                    continue
                try:
                    key, name = space_from_html(zf.read(n).decode("utf-8", "replace"))
                except Exception:
                    continue
                if key:
                    spaces.setdefault(key, {"key": key, "name": name or key, "pages": 0})

            name_to_key = {row["name"].lower(): key for key, row in spaces.items()}
            unsorted = 0
            for n in pages:
                try:
                    head = zf.read(n)[:65536].decode("utf-8", "replace")
                except Exception:
                    head = ""
                match = SPACE_META_RE.search(head)
                space = (match.group(1) if match else "").strip()
                key = name_to_key.get(space.lower())
                if key is None:
                    parts = PurePosixPath(n).parts
                    folder = parts[0] if len(parts) > 1 else ""
                    key = next((k for k in spaces if k.lower() == folder.lower()), None)
                if key is None and len(spaces) == 1:
                    key = next(iter(spaces))
                if key is None:
                    unsorted += 1
                else:
                    spaces[key]["pages"] += 1
    except (zipfile.BadZipFile, OSError) as exc:
        return fail("file-not-zip", f"cannot read the archive: {exc}")

    payload.update({
        "ok": True,
        "code": "",
        "pages": len(pages),
        "htmlFiles": len(html),
        "spaces": sorted(spaces.values(), key=lambda row: row["key"].lower()),
        "unsorted": unsorted,
    })
    if args.json:
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    else:
        print(f"file:  {path}")
        print(f"bytes: {payload['bytes']}")
        print(f"pages: {payload['pages']}")
        for row in payload["spaces"]:
            print(f"  {row['key']:<12} {row['name']}  ({row['pages']} pages)")
        if unsorted:
            print(f"  unmatched  {unsorted} pages outside any space folder")
    return 0


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="kb.py", description=__doc__.splitlines()[0])
    ap.add_argument("--kb", default=None,
                    help="knowledge base directory (default: the registry's default source)")
    ap.add_argument("--version", action="version", version=f"kb.py {VERSION}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("import", help="import a Confluence HTML export zip")
    p.add_argument("--zip", required=True)
    p.add_argument("--base-url", default="", help="Confluence base URL for source links")
    p.add_argument("--spaces", default="", help="comma-separated space keys or names to import")
    p.add_argument("--progress", action="store_true",
                   help="print PROGRESS <done>/<total> <space> lines to stderr")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("inspect", help="validate an export archive and list its spaces")
    p.add_argument("--zip", required=True)
    p.add_argument("--json", action="store_true", help="machine-readable result on stdout")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("fetch", help="import pages from a Confluence REST API (Server/Data Center)")
    p.add_argument("--url", required=True, help="base URL, e.g. https://confluence.example.local")
    p.add_argument("--token", default="", help="Personal Access Token (or CONFLUENCE_TOKEN)")
    p.add_argument("--user", default="", help="basic auth user (older servers without PAT)")
    p.add_argument("--password", default="", help="basic auth password (or CONFLUENCE_PASSWORD)")
    p.add_argument("--spaces", default="", help="comma-separated space keys; default: all visible")
    p.add_argument("--space-type", default="global", choices=["global", "personal", "all"])
    p.add_argument("--since", default="", help="only pages modified after this date (YYYY-MM-DD)")
    p.add_argument("--no-attachments", action="store_true", help="skip attachment downloads")
    p.add_argument("--save-zip", default="", help="keep the generated export archive here")
    p.add_argument("--list-spaces", action="store_true", help="show visible spaces and exit")
    p.add_argument("--progress", action="store_true",
                   help="print PROGRESS <done>/<total> <space> lines to stderr")
    p.add_argument("--insecure", action="store_true", help="skip TLS verification (self-signed cert)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("index", help="rebuild INDEX.md and the search index")
    p.set_defaults(func=lambda a: (build_index(Path(a.kb).expanduser()),
                                   print("articles indexed:", build_fts(Path(a.kb).expanduser())),
                                   0)[-1])

    p = sub.add_parser("search", help="full-text search")
    p.add_argument("query", nargs="+")
    p.add_argument("-n", type=int, default=8)
    p.add_argument("--space", default="")
    p.add_argument("--status", default="")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("get", help="print one article")
    p.add_argument("id")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("audit", help="list articles whose facts may be stale")
    p.add_argument("--stale", action="store_true", help="kept for compatibility; audit is always staleness-oriented")
    p.add_argument("--months", type=int, default=6)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_audit)

    p = sub.add_parser("stats", help="counts and status overview")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("pack", help="pack a knowledge base into a portable .zip archive")
    p.add_argument("--out", required=True, help="archive to write")
    p.add_argument("--meta", default="", help="JSON file with public source metadata to embed")
    p.add_argument("--progress", action="store_true",
                   help="print PACK <done>/<total> byte lines to stderr")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_pack)

    p = sub.add_parser("unpack", help="restore a knowledge base from a portable .zip archive")
    p.add_argument("--archive", required=True, help="archive to read")
    p.add_argument("--check", action="store_true",
                   help="validate the archive and summarize it; write nothing")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_unpack)

    args = ap.parse_args(argv)
    if not args.kb:
        args.kb = str(default_kb())
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())


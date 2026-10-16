# Copyright 2026 Kube AI Hub.
"""Playground result downloads: render the extra formats on the server.

The parse API treats HTML, LaTeX and DOCX as formats that require an API key,
and EPUB and PDF are not part of the local parse server's output list at all.
A playground that is usually opened against a local or intranet deployment
should offer them the way the WebUI does, so this module takes the result
archive the page already holds, renders the requested format with the same
renderers the WebUI uses, and hands the bytes back as a download.

Rendering happens on the archive rather than on server-side job state: the page
has already fetched the archive to show its preview, and a stateless endpoint
keeps the playground working the same way whether the job is still retained or
not.
"""

from __future__ import annotations

import base64
import io
import json
import re
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import quote

from bs4 import BeautifulSoup
from docvortex.assets import validate_image_sidecar_path

from ...parser.base import ParseResult
from ...render import (
    DocxRenderOptions,
    EpubRenderOptions,
    HtmlRenderOptions,
    LatexRenderOptions,
    PdfRenderOptions,
    RenderFormat,
    render,
)

#: Result archives are uploaded back by the page, so cap what will be read.
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

#: Formats this endpoint can render, mapped to the suffix of the download's
#: name. LaTeX ships as a bundle and the rendered PDF is named apart from the
#: source, matching what the WebUI hands over.
_RENDERABLE_FORMATS: dict[str, str] = {
    "html": ".html",
    "latex": "_latex.zip",
    "docx": ".docx",
    "epub": ".epub",
    "pdf": "_rendered.pdf",
}

#: Media types for the formats whose payload is a single file.
_MEDIA_TYPES: dict[str, str] = {
    "html": "text/html; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "epub": "application/epub+zip",
    "pdf": "application/pdf",
    "latex": "application/zip",
}

#: Raster extensions the downloaded HTML may inline as data URIs. Anything else
#: keeps its relative path instead of being embedded under a guessed type.
_RASTER_MEDIA_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}

_STEM_UNSAFE_RE = re.compile(r"[^\w.-]+", flags=re.UNICODE)


class DownloadFormatError(ValueError):
    """Raised when the request asks for something this endpoint cannot render."""


@dataclass(frozen=True)
class RenderedDownload:
    """One rendered download, ready to be streamed back."""

    payload: bytes
    media_type: str
    filename: str


def renderable_formats() -> tuple[str, ...]:
    """Return the formats this endpoint accepts."""
    return tuple(_RENDERABLE_FORMATS)


def safe_stem(value: str) -> str:
    """Reduce a client-supplied name to a safe file stem.

    The page passes the source document's name so the download keeps it, but the
    value crosses a trust boundary, so only a plain stem survives: the suffix is
    dropped, matching the WebUI, which names its downloads after the source's
    stem.
    """
    name = Path(value or "").name
    suffix = Path(name).suffix
    if suffix:
        name = name[: -len(suffix)]
    normalized = _STEM_UNSAFE_RE.sub("_", name).strip("._")
    truncated = normalized.encode("utf-8")[:120].decode("utf-8", errors="ignore")
    return truncated.strip("._") or "result"


def content_disposition(filename: str) -> str:
    """Build a Content-Disposition header that survives a non-ASCII name.

    HTTP headers are latin-1, so a Chinese source name would fail to encode and
    turn the whole download into a 500. The plain ``filename`` keeps ASCII
    clients working and ``filename*`` carries the real name, per RFC 6266.
    """
    ascii_name = filename.encode("ascii", errors="replace").decode("ascii").replace('"', "'")
    quoted = quote(filename, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"


def render_download(archive: bytes, *, format_name: str, stem: str = "") -> RenderedDownload:
    """Render ``format_name`` from a result archive and return the download.

    Args:
        archive: The self-contained result zip the page downloaded from the
            parse API. It must carry ``middle_json.json`` and may carry
            ``images/``.
        format_name: One of :func:`renderable_formats`.
        stem: Source document name, used for the download's file name.

    Raises:
        DownloadFormatError: The format is unknown or the archive is unusable.
    """
    if format_name not in _RENDERABLE_FORMATS:
        raise DownloadFormatError(f"Unsupported download format: {format_name}")
    if not archive:
        raise DownloadFormatError("The result archive is empty")

    name = safe_stem(stem)
    with TemporaryDirectory(prefix="mineru-download-") as directory:
        root = Path(directory)
        middle_json, assets = _unpack_archive(archive, root)
        try:
            result = ParseResult.from_dict(middle_json)
        except Exception as exc:  # noqa: BLE001 - reported to the page as 400
            raise DownloadFormatError(f"The result archive is not a parse result: {exc}") from exc

        payload, suffix = _render_format(result, format_name, assets=assets, root=root, stem=name)
    return RenderedDownload(
        payload=payload,
        media_type=_MEDIA_TYPES[format_name],
        filename=f"{name}{suffix}",
    )


def _unpack_archive(archive: bytes, root: Path) -> tuple[dict, dict[str, bytes]]:
    """Read the parse result and its image sidecars out of the archive.

    Member names come from the client, so every image path is validated and
    anything else in the archive is ignored: only the parse result and its
    images take part in rendering.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            names = source.namelist()
            if "middle_json.json" not in names:
                raise DownloadFormatError("The result archive carries no middle_json.json")
            middle_json = json.loads(source.read("middle_json.json").decode("utf-8"))
            assets: dict[str, bytes] = {}
            for member in names:
                if not member.startswith("images/") or member.endswith("/"):
                    continue
                try:
                    safe_path = validate_image_sidecar_path(member)
                except ValueError:
                    continue
                assets[safe_path] = source.read(member)
    except zipfile.BadZipFile as exc:
        raise DownloadFormatError("The result archive is not a zip file") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DownloadFormatError(f"The result archive is not a parse result: {exc}") from exc

    if not isinstance(middle_json, dict):
        raise DownloadFormatError("The result archive is not a parse result")
    for relative, payload in assets.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    return middle_json, assets


def _render_format(
    result: ParseResult,
    format_name: str,
    *,
    assets: Mapping[str, bytes],
    root: Path,
    stem: str,
) -> tuple[bytes, str]:
    """Render one format, returning its payload and the download's suffix."""
    middle_json = result.middle_json
    if format_name == "html":
        html = render(
            middle_json,
            RenderFormat.HTML,
            options=HtmlRenderOptions(
                # The download is a single file, so the images travel inside it
                # instead of pointing back at this server.
                standalone=True,
                document_title=stem,
                asset_base_url="",
            ),
        )
        return _inline_images(html, assets).encode("utf-8"), _RENDERABLE_FORMATS["html"]
    if format_name == "latex":
        latex = render(
            middle_json,
            RenderFormat.LATEX,
            options=LatexRenderOptions(document_title=stem),
        )
        return _pack_latex(latex, assets=assets, stem=stem), _RENDERABLE_FORMATS["latex"]
    if format_name == "docx":
        return (
            render(middle_json, RenderFormat.DOCX, options=DocxRenderOptions(asset_resolver=_asset_resolver(root))),
            _RENDERABLE_FORMATS["docx"],
        )
    if format_name == "epub":
        return (
            render(
                middle_json,
                RenderFormat.EPUB,
                options=EpubRenderOptions(title=stem, asset_resolver=_asset_resolver(root)),
            ),
            _RENDERABLE_FORMATS["epub"],
        )
    if format_name == "pdf":
        return (
            render(
                middle_json,
                RenderFormat.PDF,
                options=PdfRenderOptions(document_title=stem, asset_resolver=_asset_resolver(root)),
            ),
            _RENDERABLE_FORMATS["pdf"],
        )
    raise DownloadFormatError(f"Unsupported download format: {format_name}")


def _asset_resolver(root: Path) -> "object":
    """Build the renderer's image resolver over the unpacked sidecars."""
    resolved_root = root.resolve()

    def resolve(relative_path: str) -> bytes:
        safe_path = validate_image_sidecar_path(relative_path)
        candidate = (resolved_root / safe_path).resolve()
        if not candidate.is_relative_to(resolved_root) or not candidate.is_file():
            raise FileNotFoundError(safe_path)
        return candidate.read_bytes()

    return resolve


def _inline_images(document: str, assets: Mapping[str, bytes]) -> str:
    """Replace the rendered HTML's relative image references with data URIs.

    The renderer writes the sidecar's relative path when no asset base URL is
    configured, which only resolves next to the archive. Inlining keeps the
    downloaded document self-contained, and only raster types are embedded so a
    mislabelled member cannot be served as something else.
    """
    soup = BeautifulSoup(document, "html.parser")
    for image in soup.find_all("img", src=True):
        source = str(image["src"])
        key = source[2:] if source.startswith("./") else source
        payload = assets.get(key)
        if payload is None:
            continue
        media_type = _RASTER_MEDIA_TYPES.get(Path(key).suffix.lower())
        if media_type is None:
            continue
        image["src"] = f"data:{media_type};base64,{base64.b64encode(payload).decode('ascii')}"
    return str(soup)


def _pack_latex(latex: str, *, assets: Mapping[str, bytes], stem: str) -> bytes:
    """Bundle the .tex source with the images it includes, as the WebUI does."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{stem}.tex", latex)
        for relative, payload in sorted(assets.items()):
            archive.writestr(validate_image_sidecar_path(relative), payload)
    return buffer.getvalue()


__all__ = [
    "MAX_ARCHIVE_BYTES",
    "DownloadFormatError",
    "RenderedDownload",
    "content_disposition",
    "render_download",
    "renderable_formats",
    "safe_stem",
]

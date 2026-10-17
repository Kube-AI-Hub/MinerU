# Copyright 2026 Kube AI Hub.
"""Serving entrypoint: one port for the MinerU API, its docs and a playground.

A platform that hosts this engine usually exposes exactly one container port,
so the parse API, the OpenAPI document and the interactive playground all share
it and are separated by route:

============================  ===============================================
``/``                         playground (document parsing UI)
``/health``                   liveness and readiness probe
``/config``                   playground configuration
``/v1/*``                     the MinerU V1 parse API
``/docs``, ``/openapi.json``  Swagger UI and its spec
``/demo/*``                   bundled demo documents
============================  ===============================================

The playground is served from the container root and refers to everything by
relative path. A platform that proxies this engine strips its own prefix before
forwarding, so the container sees the same paths either way; absolute paths
would escape the proxy and hit the platform's own host instead.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from ...parser.api_server import create_app
from ...utils.async_utils import run_sync
from ...version import __version__
from .downloads import (
    MAX_ARCHIVE_BYTES,
    DownloadFormatError,
    content_disposition,
    render_download,
    renderable_formats,
)
from .model_bridge import BridgeResult, bridge_vlm_weights, weights_dir

logger = logging.getLogger(__name__)

#: Directory holding the playground page, its assets and the demo documents.
ASSETS_DIR = Path(__file__).resolve().parents[2] / "resources" / "serve"

#: Playground configuration endpoint, relative to whatever prefix is proxied.
CONFIG_PATH = "/config"

#: Renders a parse result to HTML for the result pane, using the same renderer
#: as the WebUI so both show the document the same way.
RENDER_PATH = "/render"

#: Renders one of the extra download formats from a result archive. The page
#: uploads the archive it already holds, so the endpoint keeps no state and
#: works the same way for any job.
DOWNLOAD_PATH = "/download"

#: Serves the bilingual specs the API tab renders. Kept separate from FastAPI's
#: own ``/openapi.json``: that one is the live schema and stays as it is, while
#: these carry the display-only extras (per-language copy, code samples) and
#: the ``SERVER_URL`` placeholder the page substitutes.
OPENAPI_PATH = "/openapi"

#: Spec files by language. Anything that is not ``en`` gets Chinese, matching
#: the page's own language fallback.
_OPENAPI_FILES: dict[str, str] = {
    "en": "openapi.en.yaml",
    "zh": "openapi.zh.yaml",
}

#: Placeholder the spec carries instead of a host, so the same file works
#: directly and behind a platform proxy prefix.
SERVER_URL_PLACEHOLDER = "SERVER_URL"

#: Placeholder the code samples carry for the bearer token. The page replaces it
#: with the real token when the user opts in, and leaves it as-is otherwise, so
#: the sample always shows that authentication is expected.
TOKEN_PLACEHOLDER = "YOUR_TOKEN"

#: Bundled demo documents the playground offers so a first run needs no file.
DEMO_FILES = ("demo1.pdf", "demo2.pdf")

#: The readiness check follows the bridge, so it reports the location the
#: weights were actually placed at rather than a second guess at the layout.
_weights_dir = weights_dir


def demo_documents() -> list[str]:
    """Return the bundled demo documents that are actually present."""
    return [name for name in DEMO_FILES if (ASSETS_DIR / "demo" / name).is_file()]


#: Matches the wrapper the HTML renderer puts around each parsed block. Reading
#: the keys back out of the rendered markup is what lets the page know which
#: blocks survived rendering, instead of guessing and highlighting dead regions.
_RENDERED_BLOCK_RE = re.compile(
    r'<div class="docvortex-block"[^>]*data-page-idx="(\d+)"[^>]*data-block-type="([^"]+)"'
    r'[^>]*data-block-index="(\d+)"'
)


def _block_geometry(middle_json: object) -> list[dict]:
    """Collect every block's page, type, index and normalized bbox.

    The bboxes in the parse result are normalized to the page, which is what
    lets the viewer place a rectangle without knowing the render scale.
    """
    pages = getattr(middle_json, "pages", None)
    if pages is None and isinstance(middle_json, dict):
        pages = middle_json.get("pages")
    blocks: list[dict] = []
    for page in pages or []:
        page_idx = getattr(page, "page_idx", None)
        page_blocks = getattr(page, "blocks", None)
        if page_idx is None or page_blocks is None:
            page_idx = page["page_idx"] if isinstance(page, dict) else page_idx
            page_blocks = page.get("blocks") if isinstance(page, dict) else page_blocks
        for block in page_blocks or []:
            index = getattr(block, "index", None)
            bbox = getattr(block, "bbox", None)
            if index is None or bbox is None:
                index = block["index"] if isinstance(block, dict) else index
                bbox = block.get("bbox") if isinstance(block, dict) else bbox
            block_type = getattr(block, "type", None)
            if block_type is None and isinstance(block, dict):
                block_type = block.get("type")
            if page_idx is None or index is None or not bbox or len(bbox) != 4:
                continue
            blocks.append(
                {
                    "page": int(page_idx),
                    "index": int(index),
                    "type": str(block_type or ""),
                    "bbox": [float(value) for value in bbox],
                }
            )
    return blocks


def _rendered_block_keys(html: str) -> list[str]:
    """Return the ``page:index`` keys the renderer actually emitted."""
    return [
        f"{int(page)}:{int(index)}"
        for page, _block_type, index in _RENDERED_BLOCK_RE.findall(html)
    ]


def create_serving_app(
    *,
    upload_dir: str = "",
    tier: str | None = "standard",
    api_key: str | None = None,
    concurrency: int = 1,
    preload_models: bool = False,
    model_dir: str | None = None,
    bridge: BridgeResult | None = None,
    **kwargs: object,
) -> FastAPI:
    """Build the single-port application.

    The parse API comes from :func:`~mineru.parser.api_server.create_app`, so
    this function only adds the routes a hosted deployment needs and leaves
    parsing behaviour untouched.

    Args:
        model_dir: Directory holding preloaded VLM weights. When given (or when
            the platform mount point exists) MinerU is pointed at it instead of
            downloading.
        bridge: An already-completed bridge, so a caller that bridged early can
            report the outcome without doing the work twice.
    """
    application = create_app(
        upload_dir=upload_dir,
        tier=tier,  # type: ignore[arg-type]
        api_key=api_key,
        concurrency=concurrency,
        preload_models=preload_models,
        # The platform's probe cannot carry an Authorization header, so the
        # serving health route stays reachable when an API key is configured.
        # The playground's own routes are public for the same reason: the page
        # and its assets load before the user opts into sending a token, and a
        # 401 on `/` would leave the user with nothing to opt in from.
        public_paths=(
            "/health",
            "/",
            CONFIG_PATH,
            RENDER_PATH,
            DOWNLOAD_PATH,
            OPENAPI_PATH,
            "/index.html",
            "/index.css",
            "/app.mjs",
            "/i18n.js",
            "/source-viewer.mjs",
            "/rapidoc-min-9.3.8.js",
            "/vendor",
            "/demo",
        ),
        **kwargs,  # type: ignore[arg-type]
    )

    resolved_bridge = bridge
    if resolved_bridge is None:
        try:
            resolved_bridge = bridge_vlm_weights(model_dir)
        except Exception as exc:  # noqa: BLE001 - surfaced through /health
            logger.error("Model bridge failed: %s", exc)
            resolved_bridge = None

    @application.get("/health", include_in_schema=False)
    async def health() -> JSONResponse:
        """Report readiness for the platform's probe.

        The engine is usable only once the weights are in place, so this
        reports the bridge outcome rather than answering 200 unconditionally.
        A probe that always succeeds would let a replica serve requests before
        its model is readable.
        """
        weights = _weights_dir()
        ready = weights.is_dir() and any(weights.iterdir())
        payload = {
            "status": "ok" if ready else "degraded",
            "version": __version__,
            "model_dir": str(weights),
            "model_ready": ready,
            "model_source": str(resolved_bridge.source) if resolved_bridge else None,
            "demo_documents": demo_documents(),
        }
        return JSONResponse(payload, status_code=200 if ready else 503)

    @application.get(CONFIG_PATH, include_in_schema=False)
    async def playground_config() -> JSONResponse:
        """Describe the playground for the page that is about to render it.

        Keeps the demo list and the version in one place so the page needs no
        build step to learn what the engine shipped with.
        """
        return JSONResponse(
            {
                "version": __version__,
                "demo_documents": demo_documents(),
                "demo_base": "./demo",
                "rendered_downloads": list(renderable_formats()),
                "openapi": {
                    language: f".{OPENAPI_PATH}?lang={language}" for language in _OPENAPI_FILES
                },
            }
        )

    @application.get(OPENAPI_PATH, include_in_schema=False)
    async def openapi_spec(request: Request) -> Response:
        """Serve the bilingual spec the API tab renders.

        FastAPI's own ``/openapi.json`` stays as it is: this route carries the
        display-only extras (per-language copy, code samples) and substitutes
        the two placeholders the page supplies, so one file works for every
        deployment and shows the token the user opted into.

        Query: ``lang`` (``en`` or ``zh``), ``SERVER_URL`` for the documented
        server, ``token`` for the bearer value in the samples.
        """
        language = (request.query_params.get("lang") or "zh").strip().lower()
        filename = _OPENAPI_FILES.get(language, _OPENAPI_FILES["zh"])
        path = ASSETS_DIR / filename
        if not path.is_file():
            return JSONResponse(
                {"error": f"spec file {filename} is missing from the installation"},
                status_code=500,
            )
        spec = path.read_text(encoding="utf-8")
        server_url = (request.query_params.get("SERVER_URL") or "").strip()
        token = (request.query_params.get("token") or "").strip()
        # Both placeholders stay when the caller supplies nothing: replacing
        # them with empty strings would leave a blank server and a dangling
        # "Bearer " in every sample, which reads as a broken document rather
        # than as one waiting to be filled in.
        if server_url:
            spec = spec.replace(SERVER_URL_PLACEHOLDER, server_url)
        if token:
            spec = spec.replace(TOKEN_PLACEHOLDER, token)
        return Response(content=spec, media_type="text/yaml; charset=utf-8")

    @application.post(RENDER_PATH, include_in_schema=False)
    async def render_preview(request: Request) -> JSONResponse:
        """Render a parse result to the HTML the result pane shows.

        The playground asks for this instead of converting Markdown in the
        browser so the preview goes through the same renderer the WebUI uses:
        tables, formulas and image placement then look the same in both, and
        the page carries no second Markdown implementation to keep in sync.

        Alongside the HTML it returns the page/block geometry the source
        viewer needs. Sending both keeps the comparison honest: the rectangles
        and the highlighted elements come from one parse result, and the
        rendered block keys let the page mark the blocks the renderer kept.

        Body: ``{"middle_json": <the parse result's middle_json>}``.
        """
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "body must be JSON"}, status_code=400)

        middle_json = body.get("middle_json") if isinstance(body, dict) else None
        if not isinstance(middle_json, dict):
            return JSONResponse({"error": "middle_json is required"}, status_code=400)

        try:
            from ...parser.base import ParseResult
            from ...render import HtmlRenderOptions, RenderFormat, render

            # The parse result's middle_json is a plain dict, while the renderer
            # takes the typed wrapper the WebUI also uses. Going through
            # ParseResult keeps both on one path instead of hand-building the
            # structure the renderer expects.
            result = ParseResult.from_dict(middle_json)
            html = render(
                result.middle_json,
                RenderFormat.HTML,
                options=HtmlRenderOptions(
                    # The page supplies its own chrome and styles the fragment,
                    # and the images are swapped for the archive's blobs there,
                    # so a standalone document would only duplicate both.
                    standalone=False,
                    asset_base_url="",
                ),
            )
        except Exception as exc:  # noqa: BLE001 - reported to the page
            logger.warning("Preview rendering failed: %s", exc)
            return JSONResponse({"error": str(exc)}, status_code=422)

        return JSONResponse(
            {
                "html": html,
                "blocks": _block_geometry(result.middle_json),
                "rendered_blocks": _rendered_block_keys(html),
            }
        )

    @application.post(DOWNLOAD_PATH, include_in_schema=False)
    async def render_result_download(request: Request) -> Response:
        """Render one of the extra formats from the archive the page holds.

        The parse API refuses HTML, LaTeX and DOCX without an API key, and EPUB
        and PDF are not offered by the local parse server at all. A playground
        opened against a local or intranet deployment should still be able to
        hand all of them over, so they are rendered here with the same
        renderers the WebUI uses, from the result the page already downloaded.

        Query: ``format`` (html, latex, docx, epub, pdf), ``name`` for the
        download's file name. Body: the result zip, as ``application/zip``.
        """
        format_name = (request.query_params.get("format") or "").strip().lower()
        if format_name not in renderable_formats():
            return JSONResponse(
                {"error": f"format must be one of: {', '.join(renderable_formats())}"},
                status_code=400,
            )
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_ARCHIVE_BYTES:
            return JSONResponse({"error": "the result archive is too large"}, status_code=413)

        archive = await request.body()
        if len(archive) > MAX_ARCHIVE_BYTES:
            return JSONResponse({"error": "the result archive is too large"}, status_code=413)

        try:
            # Rendering is CPU-bound and touches the disk, so keep it off the
            # event loop; the page waits on this response.
            download = await run_sync(
                render_download,
                archive,
                format_name=format_name,
                stem=request.query_params.get("name") or "",
            )
        except DownloadFormatError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        except Exception as exc:  # noqa: BLE001 - reported to the page
            logger.warning("Result download rendering failed for %s: %s", format_name, exc)
            return JSONResponse({"error": f"rendering {format_name} failed: {exc}"}, status_code=422)

        return Response(
            content=download.payload,
            media_type=download.media_type,
            headers={"Content-Disposition": content_disposition(download.filename)},
        )

    @application.get("/", include_in_schema=False)
    async def playground() -> FileResponse:
        """Serve the playground page."""
        return FileResponse(ASSETS_DIR / "index.html")

    # Mounted last so it only handles what the API routes above did not claim.
    # Serving the assets from the root keeps every reference in the page
    # relative, which is what lets the same page work both directly and behind
    # a proxy that strips its own prefix.
    #
    # The assets are revalidated on every load. They change with the engine
    # image, and a browser that heuristically caches them would keep rendering
    # a previous version's page after an upgrade, which is hard to diagnose
    # from the outside.
    application.mount(
        "/",
        StaticFiles(directory=ASSETS_DIR, html=True),
        name="playground",
    )

    @application.middleware("http")
    async def _revalidate_playground_assets(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        """让 Playground 静态资源每次回源校验，避免升级后仍用旧缓存。"""
        response = await call_next(request)
        path = request.url.path
        if path in ("/", CONFIG_PATH) or path.startswith("/demo/"):
            response.headers["Cache-Control"] = "no-cache"
        elif path.endswith((".html", ".css", ".js", ".mjs")):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    return application


__all__ = [
    "ASSETS_DIR",
    "CONFIG_PATH",
    "DEMO_FILES",
    "DOWNLOAD_PATH",
    "OPENAPI_PATH",
    "RENDER_PATH",
    "create_serving_app",
    "demo_documents",
]

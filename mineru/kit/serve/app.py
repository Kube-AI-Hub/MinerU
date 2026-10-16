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
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from ...parser.api_server import create_app
from ...version import __version__
from .model_bridge import BridgeResult, bridge_vlm_weights, weights_dir

logger = logging.getLogger(__name__)

#: Directory holding the playground page, its assets and the demo documents.
ASSETS_DIR = Path(__file__).resolve().parents[2] / "resources" / "serve"

#: Playground configuration endpoint, relative to whatever prefix is proxied.
CONFIG_PATH = "/config"

#: Renders a parse result to HTML for the result pane, using the same renderer
#: as the WebUI so both show the document the same way.
RENDER_PATH = "/render"

#: Bundled demo documents the playground offers so a first run needs no file.
DEMO_FILES = ("demo1.pdf", "demo2.pdf")

#: The readiness check follows the bridge, so it reports the location the
#: weights were actually placed at rather than a second guess at the layout.
_weights_dir = weights_dir


def demo_documents() -> list[str]:
    """Return the bundled demo documents that are actually present."""
    return [name for name in DEMO_FILES if (ASSETS_DIR / "demo" / name).is_file()]


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
        # and its assets load before the user opts into sending a token.
        public_paths=("/health", CONFIG_PATH, RENDER_PATH),
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
            }
        )

    @application.post(RENDER_PATH, include_in_schema=False)
    async def render_preview(request: Request) -> JSONResponse:
        """Render a parse result to the HTML the result pane shows.

        The playground asks for this instead of converting Markdown in the
        browser so the preview goes through the same renderer the WebUI uses:
        tables, formulas and image placement then look the same in both, and
        the page carries no second Markdown implementation to keep in sync.

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

        return JSONResponse({"html": html})

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
        elif path.endswith((".html", ".css", ".js")):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    return application


__all__ = [
    "ASSETS_DIR",
    "CONFIG_PATH",
    "DEMO_FILES",
    "RENDER_PATH",
    "create_serving_app",
    "demo_documents",
]

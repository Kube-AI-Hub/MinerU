# Copyright 2026 Kube AI Hub.
"""``mineru-kit serve`` - one port for the API, its docs and a playground."""

from __future__ import annotations

from pathlib import Path

import typer

from ...parser.api_server import _build_server_log_config
from ...utils.i18n import t
from ...utils.logger import configure_global_log_level
from ...utils.stdio import configure_standard_streams
from ..errors import exit_with_message
from ..serve.model_bridge import MODEL_DIR_ENV, ModelBridgeError, bridge_vlm_weights

SERVE_COMMAND_ORDER = ("serve", "parse", "webui", "api-server", "vlm-server", "router", "models", "version")


def serve_cmd(
    host: str = typer.Option("0.0.0.0", "--host", help=t("Server host")),
    port: int = typer.Option(8000, "--port", help=t("Server port")),
    model_dir: str | None = typer.Option(
        None,
        "--model-dir",
        envvar=MODEL_DIR_ENV,
        help=t("Directory holding preloaded VLM weights; empty selects the platform mount point"),
    ),
    upload_dir: str = typer.Option("", "--upload-dir", help=t("Upload directory")),
    tier: str | None = typer.Option(
        "standard",
        "--tier",
        help=t("Server capability tier: flash, basic, or standard"),
    ),
    no_flash: bool = typer.Option(False, "--no-flash", help=t("Disable Flash tier advertisement and execution")),
    no_advanced: bool = typer.Option(False, "--no-advanced", help=t("Disable Advanced tier advertisement and execution")),
    concurrency: int = typer.Option(1, "--concurrency", help=t("Maximum concurrent parse jobs")),
    url_timeout: int = typer.Option(60, "--url-timeout", help=t("Timeout for URL source downloads")),
    allow_local_source: bool = typer.Option(False, "--allow-local-source", help=t("Allow local source paths")),
    allow_http_source: bool = typer.Option(False, "--allow-http-source", help=t("Allow URL sources to use plain HTTP")),
    max_inline_bytes: int = typer.Option(
        1024 * 1024, "--max-inline-bytes", help=t("Maximum decoded bytes for inline sources")
    ),
    disable_image_analysis: bool = typer.Option(False, "--disable-image-analysis", help=t("Disable image analysis")),
    preload_models: bool = typer.Option(
        False, "--preload-models", help=t("Initialize VLM client and local Hybrid models at startup")
    ),
    api_key: str | None = typer.Option(None, "--api-key", help=t("Optional fixed API key")),
    log_level: str | None = typer.Option(
        None,
        "--log-level",
        help=t("API service log level: critical, error, warning, info, debug, trace; default: global log.level"),
    ),
    require_model_dir: bool = typer.Option(
        True,
        "--require-model-dir/--allow-download",
        help=t(
            "Fail fast when no preloaded weights are found. Default suits a hosted deployment, "
            "where a missing mount should not silently download at startup; pass --allow-download "
            "to fall back to MinerU's own model resolution."
        ),
    ),
) -> None:
    """Serve the parse API, its OpenAPI docs and the playground on one port.

    Hosted platforms usually expose a single container port, so everything is
    separated by route instead of by port: ``/`` is the playground,
    ``/health`` the probe, ``/v1/*`` the parse API and ``/docs`` the Swagger UI.

    Weights are normally preloaded by the platform. Pass ``--model-dir`` (or set
    ``MINERU_MODEL_DIR``) to point at them, or ``--allow-download`` to let
    MinerU resolve and download its own models, which is what a local
    developer wants.
    """
    try:
        bridge = bridge_vlm_weights(model_dir, required=require_model_dir)
    except ModelBridgeError as exc:
        exit_with_message("model_not_ready", str(exc), "model_dir")

    from ..serve.app import create_serving_app

    application = create_serving_app(
        upload_dir=upload_dir,
        tier=tier,
        api_key=api_key,
        concurrency=concurrency,
        url_timeout=url_timeout,
        allow_local_source=allow_local_source,
        allow_http_source=allow_http_source,
        max_inline_bytes=max_inline_bytes,
        image_analysis=not disable_image_analysis,
        preload_models=preload_models,
        bridge=bridge,
    )

    assets = Path(__file__).resolve().parents[2] / "resources" / "serve"
    if not (assets / "index.html").is_file():
        exit_with_message(
            "invalid_request",
            t("Playground assets are missing from the installation: {path}", path=str(assets)),
        )

    import uvicorn

    configure_standard_streams()
    global_log_level = configure_global_log_level()
    server_log_level = (log_level if log_level is not None else global_log_level).lower()
    uvicorn.run(
        application,
        host=host,
        port=port,
        log_level=server_log_level,
        log_config=_build_server_log_config(server_log_level),
    )


def main() -> None:
    """Run the serve command as its own entrypoint."""
    configure_standard_streams()
    configure_global_log_level()
    app = typer.Typer(add_completion=False)
    app.command(help=t("Serve the parse API, its OpenAPI docs and the playground on one port."))(serve_cmd)
    app()


__all__ = ["serve_cmd", "main"]

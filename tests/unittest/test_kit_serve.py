# Copyright 2026 Kube AI Hub.
"""``mineru-kit serve``: command registration, single-port routes and the bridge."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from mineru.kit.commands import serve as serve_command
from mineru.kit.serve import app as serve_app
from mineru.kit.serve import model_bridge

WEIGHT_FILES = ("config.json",)


def _write_weights(directory: Path) -> Path:
    """Create a directory that satisfies the bridge's weight check."""
    directory.mkdir(parents=True, exist_ok=True)
    for name in WEIGHT_FILES:
        (directory / name).write_text("{}", encoding="utf-8")
    return directory


@pytest.fixture()
def model_home(tmp_path, monkeypatch):
    """Redirect the model root away from the developer's real ~/.mineru.

    ``config`` is resolved once at import, so ``MINERU_HOME`` cannot move the
    root any more. Both the bridge and MinerU's own readiness check go through
    ``ModelRepo.local_dir``, so patching that keeps them agreeing - which is
    the property the tests need to exercise.
    """
    home = tmp_path / "mineru-home"
    target = home / "MinerU2.5-Pro-2605-1.2B"

    from mineru.model.download import ModelRepo

    monkeypatch.setattr(ModelRepo, "local_dir", lambda self: target)
    monkeypatch.setattr(model_bridge, "_target_dir", lambda: target)
    return home


class TestServeCommand:
    def test_registered_on_the_kit_cli(self):
        from mineru.kit.main import TOP_LEVEL_COMMAND_ORDER, app

        assert "serve" in TOP_LEVEL_COMMAND_ORDER
        assert "serve" in [getattr(c, "name", None) for c in app.registered_commands]

    def test_exposes_a_standalone_entrypoint(self):
        assert callable(serve_command.main)
        assert callable(serve_command.serve_cmd)

    def test_requires_a_model_dir_by_default(self, monkeypatch):
        monkeypatch.setattr(model_bridge, "_incoming_model_dir", lambda explicit=None: None)
        with pytest.raises(model_bridge.ModelBridgeError):
            model_bridge.bridge_vlm_weights(required=True)

    def test_allows_download_when_not_required(self, monkeypatch):
        monkeypatch.setattr(model_bridge, "_incoming_model_dir", lambda explicit=None: None)
        assert model_bridge.bridge_vlm_weights(required=False) is None


class TestModelBridge:
    def test_exposes_the_weights_at_the_registry_location(self, tmp_path, model_home):
        source = _write_weights(tmp_path / "mounted")

        result = model_bridge.bridge_vlm_weights(source, required=True)

        assert result is not None
        assert result.target.is_dir()
        assert (result.target / "config.json").is_file()
        assert result.linked is True

    def test_never_writes_into_the_source_directory(self, tmp_path, model_home):
        """A platform mount is commonly read-only, so the marker cannot go there."""
        source = _write_weights(tmp_path / "mounted")

        result = model_bridge.bridge_vlm_weights(source, required=True)

        assert result is not None
        assert (result.target / model_bridge.MODEL_COMPLETE_MARKER).is_file()
        assert not (source / model_bridge.MODEL_COMPLETE_MARKER).exists()

    def test_does_not_copy_the_weights(self, tmp_path, model_home):
        """Linking keeps a multi-gigabyte model off the container's disk."""
        source = _write_weights(tmp_path / "mounted")
        (source / "model.safetensors").write_text("weights", encoding="utf-8")

        result = model_bridge.bridge_vlm_weights(source, required=True)

        assert result is not None
        linked = result.target / "model.safetensors"
        assert linked.is_symlink()
        assert linked.resolve() == (source / "model.safetensors").resolve()

    def test_marks_the_directory_ready_so_mineru_does_not_download(self, tmp_path, model_home):
        """This is the property the whole bridge exists for."""
        from mineru.model.download import model_path_exists
        from mineru.model.registry import MINERU_2_5_PRO_2605_1_2B

        source = _write_weights(tmp_path / "mounted")
        model_bridge.bridge_vlm_weights(source, required=True)

        assert model_path_exists(MINERU_2_5_PRO_2605_1_2B.path(""))

    def test_rejects_a_directory_without_weights(self, tmp_path, model_home):
        empty = tmp_path / "empty"
        empty.mkdir()

        with pytest.raises(model_bridge.ModelBridgeError):
            model_bridge.bridge_vlm_weights(empty, required=True)

    def test_is_idempotent(self, tmp_path, model_home):
        source = _write_weights(tmp_path / "mounted")

        first = model_bridge.bridge_vlm_weights(source, required=True)
        second = model_bridge.bridge_vlm_weights(source, required=True)

        assert first is not None and second is not None
        assert second.linked is False
        assert (second.target / "config.json").is_file()

    def test_relinks_when_a_different_directory_is_supplied(self, tmp_path, model_home):
        first = _write_weights(tmp_path / "first")
        second = _write_weights(tmp_path / "second")
        (second / "extra.json").write_text("{}", encoding="utf-8")

        model_bridge.bridge_vlm_weights(first, required=True)
        result = model_bridge.bridge_vlm_weights(second, required=True)

        assert result is not None
        assert result.linked is True
        assert (result.target / "extra.json").is_file()

    def test_env_var_selects_the_directory(self, tmp_path, model_home, monkeypatch):
        source = _write_weights(tmp_path / "from-env")
        monkeypatch.setenv(model_bridge.MODEL_DIR_ENV, str(source))

        result = model_bridge.bridge_vlm_weights(required=True)

        assert result is not None
        assert result.source == source

    def test_platform_mount_point_is_the_default(self, monkeypatch):
        """A hosted deploy sets no variable; the platform's mount is the default."""
        monkeypatch.delenv(model_bridge.MODEL_DIR_ENV, raising=False)
        monkeypatch.setattr(Path, "is_dir", lambda self: str(self) == model_bridge.DEFAULT_PLATFORM_MODEL_DIR)

        assert model_bridge._incoming_model_dir() == Path(model_bridge.DEFAULT_PLATFORM_MODEL_DIR)


class TestServingApp:
    @pytest.fixture()
    def client(self, tmp_path, model_home, monkeypatch):
        source = _write_weights(tmp_path / "mounted")
        monkeypatch.setenv(model_bridge.MODEL_DIR_ENV, str(source))
        from fastapi.testclient import TestClient

        application = serve_app.create_serving_app(tier="standard", model_dir=str(source))
        with TestClient(application) as test_client:
            yield test_client

    def test_health_reports_readiness(self, client):
        response = client.get("/health")

        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "ok"
        assert payload["model_ready"] is True

    def test_health_lists_the_bundled_examples(self, client):
        payload = client.get("/health").json()

        assert payload["demo_documents"] == list(serve_app.DEMO_FILES)

    def test_playground_is_served_at_the_root(self, client):
        response = client.get("/")

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "MinerU" in response.text

    def test_playground_config_describes_the_examples(self, client):
        payload = client.get(serve_app.CONFIG_PATH).json()

        assert payload["demo_documents"] == list(serve_app.DEMO_FILES)
        assert payload["version"]
        # Relative, so the page works both directly and behind a proxy prefix.
        assert not payload["demo_base"].startswith("/")

    def test_bundled_examples_are_downloadable(self, client):
        for name in serve_app.DEMO_FILES:
            response = client.get(f"/demo/{name}")
            assert response.status_code == 200, name
            assert response.content.startswith(b"%PDF"), name

    def test_playground_assets_are_served_from_the_root(self, client):
        """Relative references from / must resolve without a prefix."""
        for name in ("index.css", "app.mjs", "i18n.js", "source-viewer.mjs"):
            assert client.get(f"/{name}").status_code == 200, name

    def test_playground_refers_to_everything_relatively(self):
        """Absolute paths would escape a proxy that strips its own prefix."""
        markup = (serve_app.ASSETS_DIR / "index.html").read_text(encoding="utf-8")
        script = (serve_app.ASSETS_DIR / "app.mjs").read_text(encoding="utf-8")

        for document in (markup, script):
            for line in document.splitlines():
                stripped = line.strip()
                if stripped.startswith("//") or stripped.startswith("*"):
                    continue
                assert '"/v1' not in stripped, stripped
                assert "'/v1" not in stripped, stripped
                assert '"/playground' not in stripped, stripped
                assert "'/playground" not in stripped, stripped

    def test_assets_are_revalidated_instead_of_heuristically_cached(self, client):
        """A stale page after an image upgrade is hard to diagnose remotely."""
        for path in ("/", "/index.css", "/app.mjs", "/i18n.js", serve_app.CONFIG_PATH):
            response = client.get(path)
            assert response.headers.get("cache-control") == "no-cache", path

    def test_v1_api_is_mounted_on_the_same_port(self, client):
        assert client.get("/v1/health").status_code == 200

    def test_openapi_document_is_available(self, client):
        assert "paths" in client.get("/openapi.json").json()

    def test_swagger_refers_to_its_assets_relatively(self, client):
        """rproxy strips its prefix and sends no root_path, so absolute URLs break."""
        markup = client.get("/docs").text

        assert 'href="./docs/assets/vendor/swagger-ui.css"' in markup
        assert "url: './openapi.json'" in markup
        assert 'href="/docs/' not in markup

    def test_render_endpoint_renders_a_parse_result(self, client):
        """The result pane gets its HTML from the engine, not from the browser.

        The fixture is a real one-page middle_json produced by this engine, so
        the test also pins the schema the renderer expects.
        """
        fixture = Path(__file__).resolve().parents[1] / "fixtures" / "middle_small.json"
        middle_json = json.loads(fixture.read_text(encoding="utf-8"))

        response = client.post(serve_app.RENDER_PATH, json={"middle_json": middle_json})

        assert response.status_code == 200, response.text
        payload = response.json()
        html = payload["html"]
        assert "<" in html
        assert "flow duration curves" in html.lower()
        # The source viewer needs the geometry to draw its overlays, and the
        # rendered keys to know which of them can be selected.
        assert payload["blocks"], "block geometry is required for cross-highlighting"
        assert payload["rendered_blocks"], "rendered block keys are required"
        sample = payload["blocks"][0]
        assert {"page", "index", "type", "bbox"} <= set(sample)
        assert len(sample["bbox"]) == 4
        assert all(0.0 <= value <= 1.0 for value in sample["bbox"])
        assert set(payload["rendered_blocks"]) <= {
            f"{block['page']}:{block['index']}" for block in payload["blocks"]
        }

    def test_render_endpoint_rejects_a_missing_body(self, client):
        assert client.post(serve_app.RENDER_PATH, json={}).status_code == 400

    def test_render_endpoint_reports_a_schema_mismatch(self, client):
        """A body that is not a parse result fails loudly instead of rendering blank."""
        response = client.post(serve_app.RENDER_PATH, json={"middle_json": {"pages": []}})

        assert response.status_code == 422
        assert "error" in response.json()

    def test_render_stays_reachable_when_an_api_key_is_configured(self, tmp_path, model_home):
        """The page loads its preview before the user opts into sending a token."""
        source = _write_weights(tmp_path / "mounted")
        from fastapi.testclient import TestClient

        application = serve_app.create_serving_app(
            tier="standard", model_dir=str(source), api_key="secret"
        )
        with TestClient(application) as test_client:
            response = test_client.post(serve_app.RENDER_PATH, json={"middle_json": {}})
            assert response.status_code != 401

    def test_health_stays_reachable_when_an_api_key_is_configured(self, tmp_path, model_home):
        """The platform's probe cannot send an Authorization header."""
        source = _write_weights(tmp_path / "mounted")
        from fastapi.testclient import TestClient

        application = serve_app.create_serving_app(
            tier="standard", model_dir=str(source), api_key="secret"
        )
        with TestClient(application) as test_client:
            assert test_client.get("/health").status_code == 200
            assert test_client.get("/v1/tiers").status_code == 200
            # A key-protected route still refuses an anonymous caller.
            assert test_client.get("/v1/tasks/none").status_code == 401

    def test_degraded_when_no_weights_are_present(self, tmp_path, model_home, monkeypatch):
        """A replica must not report ready before its model is readable."""
        monkeypatch.setattr(model_bridge, "_incoming_model_dir", lambda explicit=None: None)
        from fastapi.testclient import TestClient

        application = serve_app.create_serving_app(tier="standard")
        with TestClient(application) as test_client:
            response = test_client.get("/health")

        assert response.status_code == 503
        assert response.json()["model_ready"] is False


class TestPackaging:
    def test_assets_ship_with_the_package(self):
        assert serve_app.ASSETS_DIR.is_dir()
        for name in ("index.html", "index.css", "app.mjs", "source-viewer.mjs"):
            assert (serve_app.ASSETS_DIR / name).is_file(), name

    def test_demo_documents_ship_with_the_package(self):
        assert serve_app.demo_documents() == list(serve_app.DEMO_FILES)

    def test_package_data_covers_the_serve_assets(self):
        """The assets live under mineru/resources, which package-data already ships."""
        project_root = Path(__file__).resolve().parents[2]
        pyproject = (project_root / "pyproject.toml").read_text(encoding="utf-8")

        assert 'resources/**' in pyproject

    def test_i18n_offers_the_languages_the_platform_can_request(self):
        source = (serve_app.ASSETS_DIR / "i18n.js").read_text(encoding="utf-8")

        assert "zh:" in source and "en:" in source
        # The platform passes ?lang=, so the page must read it.
        assert "lang" in source


class TestResponseParsing:
    """The playground reads the parse API's response directly.

    A wrong guess here is silent: the request succeeds and the result pane stays
    empty, which reads as "the engine is broken". The shapes below are the ones
    the API actually returns.
    """

    @pytest.fixture()
    def script(self):
        return (serve_app.ASSETS_DIR / "app.mjs").read_text(encoding="utf-8")

    @pytest.fixture()
    def viewer(self):
        return (serve_app.ASSETS_DIR / "source-viewer.mjs").read_text(encoding="utf-8")

    def test_reads_the_markdown_from_the_archive(self, script):
        """The zip response carries the Markdown as markdown.md."""
        assert "markdown.md" in script

    def test_reads_the_structured_json_from_the_archive(self, script):
        """The JSON pane and the preview both need middle_json.json."""
        assert "middle_json.json" in script

    def test_asks_for_every_format_the_preview_needs(self, script):
        """One request must carry what the preview and the menu need."""
        assert "'middle_json'" in script
        assert "'structured_content'" in script

    def test_requests_zip_when_submitting(self, script):
        """The result endpoint only serves an archive if zip was requested.

        Asking for it at result time returns 400 "Request zip in output_formats
        when submitting the task".
        """
        assert "'zip'" in script
        assert "response_format=zip" in script

    def test_does_not_send_response_format_on_submit(self, script):
        """The task API forbids unknown submit parameters."""
        submit = script[script.index("./v1/tasks?"): script.index("./v1/tasks?") + 400]
        assert "response_format" not in submit

    def test_shows_the_engines_own_stages(self, script):
        """Progress must come from the task document, not a guessed bar."""
        assert "queued" in script
        assert "running" in script
        assert "pollTask" in script

    def test_force_ocr_locks_the_mode(self, script):
        """Force OCR means "ignore the text layer", which is the ocr mode."""
        assert "forceOcr" in script

    def test_marks_the_formats_that_need_an_api_key(self, script):
        """html/latex/docx are refused without a key, so the menu disables them."""
        assert "needsKey" in script

    def test_reports_the_nested_error_message(self, script):
        """The reason lives at files[].error.message, not at the top level."""
        assert "error.message" in script

    def test_renders_the_preview_through_the_engine(self, script):
        """Using the engine's renderer keeps the preview identical to the WebUI."""
        assert "./render" in script

    def test_keys_both_panes_by_page_and_block(self, script):
        """Cross-highlighting needs one shared key on both sides."""
        assert "data-page-idx" in script
        assert "data-block-index" in script

    def test_uses_relative_paths_only(self, script):
        """Absolute paths would escape a proxy that strips its own prefix."""
        for line in script.splitlines():
            stripped = line.strip()
            if stripped.startswith("//") or stripped.startswith("*"):
                continue
            assert "'/v1" not in stripped, stripped
            assert '"/v1' not in stripped, stripped

    def test_source_viewer_places_overlays_from_the_parse_result(self, viewer):
        """Overlay geometry comes from middle_json, not from a second parse."""
        assert "blockMap" in viewer
        assert "bbox" in viewer

    def test_source_viewer_reports_selection_both_ways(self, viewer):
        """A click in the source has to reach the result pane."""
        assert "onSelect" in viewer
        assert "onHover" in viewer

    def test_source_viewer_loads_its_bundle_relatively(self, viewer):
        """The pdf.js bundle ships with the page, so it must resolve relatively."""
        assert "./vendor/pdfjs" in viewer
        assert "https://" not in viewer

    def test_source_viewer_anchors_assets_to_the_module(self, viewer):
        """Character maps and fonts must resolve against this module.

        Resolved against the document instead, a page served at / or under the
        platform's proxy prefix looks for them in the wrong place, and a missing
        cMap silently drops text from the render — how a Chinese PDF ends up
        blank.
        """
        assert "import.meta.url" in viewer
        for asset in ("cmaps/", "standard_fonts/", "wasm/", "pdf.worker.min.mjs"):
            assert asset in viewer, asset

    def test_source_viewer_indexes_pages_by_number(self, viewer):
        """Indexing must be by page number and stay stable while rendering.

        Building the list with push and then writing back by page number shifts
        every entry by one: page 1 lands at two indices, the last page falls
        outside the array, and the render loop stops early — pages then alternate
        between drawn and blank.
        """
        assert "this.pages[pageNumber] = " in viewer
        assert "this.pages.push(" not in viewer

    def test_source_viewer_reports_progress(self, viewer):
        """Loading a large PDF needs visible progress, not an empty pane."""
        assert "onProgress" in viewer

    def test_source_viewer_toolbar_has_page_navigation(self, viewer):
        """The toolbar shows a page box and navigation, not the file name."""
        assert "source-page-input" in viewer
        assert "source-page-total" in viewer
        assert "goToPage" in viewer


def test_health_payload_is_json_serialisable(tmp_path, model_home):
    """The probe body must not depend on non-serialisable values."""
    source = _write_weights(tmp_path / "mounted")
    result = model_bridge.bridge_vlm_weights(source, required=True)

    assert result is not None
    json.dumps({"model_source": str(result.source)})

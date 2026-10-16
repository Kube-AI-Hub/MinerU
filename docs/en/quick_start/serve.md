# Single-port serving (`mineru-kit serve`)

`mineru-kit serve` puts the **parse API, the OpenAPI documentation and the Playground page on one port**, so a hosting platform (for example a model-platform inference instance) can expose the engine through a single container port. It also runs standalone, which is the quickest way to try the API and see parsing results.

A container port usually carries one service, so these are separated by route rather than by opening more ports:

| Route | Purpose |
| --- | --- |
| `/` | Playground: pick a file, pick a parsing level, read the Markdown |
| `/health` | Health check for the platform's probe |
| `/config` | Playground configuration (version and bundled examples) |
| `/render` | Render `middle_json` to formatted HTML and return block geometry (for the comparison highlight) |
| `/download` | Convert a result archive in place to HTML / LaTeX / DOCX / EPUB / PDF |
| `/v1/*` | The MinerU V1 parse API, same as `mineru-kit api-server` |
| `/docs`, `/openapi.json` | Swagger UI and the API description |
| `/demo/*` | Bundled example documents |

Both the Playground and the interface documentation refer to their own assets by **relative** path. A platform's inference proxy strips its own prefix before forwarding, so an absolute path would resolve against the platform instead of this service.

## Running it standalone

The simplest form, letting MinerU resolve or download its own models:

```bash
mineru-kit serve --allow-download
```

[http://127.0.0.1:8000](http://127.0.0.1:8000) is the Playground and [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) is the API reference.

Point it at weights that already exist, so nothing is downloaded at startup:

```bash
mineru-kit serve --model-dir /path/to/weights
```

By default `mineru-kit serve` **requires** preloaded weights (`--require-model-dir`): in a hosted deployment a missing mount should fail at startup rather than silently downloading gigabytes inside the pod. Pass `--allow-download` to fall back to MinerU's own model resolution during local development.

Common options:

| Option | Meaning |
| --- | --- |
| `--host` / `--port` | Listen address and port; defaults to `0.0.0.0:8000` |
| `--model-dir` | Directory holding preloaded weights; reads `MINERU_MODEL_DIR`, then the platform mount point `/mnt/models/model` |
| `--require-model-dir` / `--allow-download` | Fail fast when no weights are found (default), or fall back to MinerU's own resolution |
| `--tier` | Server capability ceiling: `flash`, `basic`, or `standard` (default) |
| `--api-key` | Fixed API key; `/health`, `/config` and `/docs` stay reachable so the probe is never blocked |
| `--preload-models` | Initialize the VLM client and local Hybrid models at startup |

Everything else (concurrency, source restrictions, log level) matches `mineru-kit api-server`; see `mineru-kit serve --help`.

## Where the model comes from

The service does **not** download the VLM weights. They come from one of two places:

1. **A platform mount**: a hosted deployment downloads the model to `/mnt/models/model` and mounts it read-only. `mineru-kit serve` bridges that directory into the location MinerU expects and writes the completion marker there, so `get_vlm_predictor` treats the model as ready instead of downloading it.
2. **A local directory**: point `--model-dir` or `MINERU_MODEL_DIR` anywhere.

The bridge writes only into the target directory (`$MINERU_HOME/models/MinerU2.5-Pro-2605-1.2B`), **never into the source**, because a platform mount may be read-only; entries are linked rather than copied so gigabytes are not duplicated. A directory without `config.json` is not treated as weights, and reports a clear error instead of looking ready.

The small model bundle (layout, OCR, formula, table; repo name `MinerU-4_models_torch`) is a fixed asset of the engine and is normally **baked into the image**:

```bash
mineru-kit models download MinerU-4_models_torch -s modelscope
```

Naming the repo downloads only that one; `--tier standard` would also fetch the VLM weights, which a hosted deployment does not need.

## Health check

`GET /health` returns 200 once the weights are ready, and 503 with `model_ready: false` otherwise:

```json
{
  "status": "ok",
  "version": "4.0.12",
  "model_dir": "/root/.mineru/models/MinerU2.5-Pro-2605-1.2B",
  "model_ready": true,
  "model_source": "/mnt/models/model",
  "demo_documents": ["demo1.pdf", "demo2.pdf"]
}
```

A platform probe cannot send an Authorization header, so this route stays reachable when `--api-key` is configured. A replica must not be considered ready before its model is readable, which is why the status is real rather than an unconditional 200.

## Playground

Two example documents ship with the page (`/demo/demo1.pdf`, `/demo/demo2.pdf`), so a first run needs no file of your own.

- **Parse** tab: choose a file or click an example, pick a parsing level, tick Force OCR, and select a page range with the two sliders; the result pane shows formatted Markdown and can switch to a JSON view. The stage list on the left lights up as the engine reports its own progress (preparing request → submitting job → queued → parsing → downloading result → assembling output → done) with a running timer.
- **Comparison**: the middle column previews the source document (PDFs page, jump and zoom), and highlights are bidirectional with the result pane — hover a block on either side and the other follows; click to pin the selection.
- **Download**: Markdown / JSON / Structured JSON come straight from the parse artifacts; HTML / LaTeX / DOCX / EPUB / PDF are converted in place by `/download` using the same renderer as the WebUI and need **no API key** (LaTeX arrives as `_latex.zip`, PDF as `_rendered.pdf`); ZIP is the full artifact bundle.
- **API** tab: the interface documentation (RapiDoc), embedded, so `/v1/file_parse` can be called from the page.
- The page reads `?lang=` and `?token=`: the first follows the platform's language, the second is sent as an `Authorization` header when "Use my access token" is ticked, and the API tab's calls carry it too.

Static assets carry `Cache-Control: no-cache`. They change with the engine image, and a heuristically cached copy would keep rendering a previous version's page after an upgrade, which is hard to diagnose from the outside.

## Docker

The image bakes only the small model bundle; the VLM weights are left to the platform mount:

```bash
docker build -t mineru:4.0.12-cu130 -f docker/china/Dockerfile.mineru .
docker run --gpus all --shm-size 32g --ipc=host \
  -p 8000:8000 \
  -v /path/to/weights:/mnt/models/model:ro \
  mineru:4.0.12-cu130
```

Its entrypoint is exactly `mineru-kit serve --host 0.0.0.0 --port 8000 --tier standard`, with `MINERU_MODEL_DIR=/mnt/models/model` already set.

## See also

- [Docker deployment](docker_deployment.md)
- [SDK and API](../usage/sdk_api.md)
- [Model download and configuration](../usage/model_source.md)

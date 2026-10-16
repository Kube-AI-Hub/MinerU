# 单端口服务（`mineru-kit serve`）

`mineru-kit serve` 把**解析 API、OpenAPI 文档和 Playground 页面收在同一个端口**上，供托管平台（如模型平台推理实例）以单端口方式暴露；也可以脱离平台独立运行，用来看接口、试解析效果。

一个容器端口通常只允许暴露一个服务，因此这里用路由区分，而不是多开端口：

| 路由 | 用途 |
| --- | --- |
| `/` | Playground 页面：选文件、选档位、看 Markdown 结果 |
| `/health` | 健康检查，供平台的探针使用 |
| `/config` | Playground 的配置（版本与内置示例文件清单） |
| `/v1/*` | MinerU V1 解析 API，与 `mineru-kit api-server` 相同 |
| `/docs`、`/openapi.json` | Swagger UI 与接口描述 |
| `/demo/*` | 内置示例文档 |

Playground 与 Swagger 都使用**相对地址**引用自身资源。平台的推理代理会剥掉自己的路径前缀，绝对地址会指向平台本身而不是本服务，所以页面里不出现以 `/` 开头的接口地址。

## 独立运行

最简方式，让 MinerU 按自己的配置解析或下载模型：

```bash
mineru-kit serve --allow-download
```

打开 [http://127.0.0.1:8000](http://127.0.0.1:8000) 是 Playground，[http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) 是接口文档。

指向一份已有的权重目录，不在启动时下载：

```bash
mineru-kit serve --model-dir /path/to/weights
```

`mineru-kit serve` 默认**要求**能找到预置权重（`--require-model-dir`）：托管部署里挂载缺失应该在启动阶段报错退出，而不是在 Pod 里静默下载几 GB。本地开发想让它自己解析模型时加 `--allow-download`。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--host` / `--port` | 监听地址与端口，默认 `0.0.0.0:8000` |
| `--model-dir` | 预置权重目录，默认读 `MINERU_MODEL_DIR`，再退到平台挂载点 `/mnt/models/model` |
| `--require-model-dir` / `--allow-download` | 找不到权重时报错退出（默认），或回退到 MinerU 自身的模型解析 |
| `--tier` | 服务能力上限：`flash`、`basic`、`standard`（默认） |
| `--api-key` | 固定 API key；配置后 `/health`、`/config` 与 `/docs` 仍免鉴权，探针不会被挡住 |
| `--preload-models` | 启动时初始化 VLM 客户端与本地 Hybrid 模型 |

其余参数（并发、来源限制、日志级别等）与 `mineru-kit api-server` 一致，见 `mineru-kit serve --help`。

## 模型从哪来

服务本身**不下载 VLM 权重**。权重有两个来源：

1. **平台挂载**：托管部署时由平台把模型下到 `/mnt/models/model` 并只读挂载，`mineru-kit serve` 在启动时把该目录桥接到 MinerU 期望的位置，并写入完成标记，使 `get_vlm_predictor` 认为模型已就绪而不再触发下载。
2. **本地目录**：用 `--model-dir` 或 `MINERU_MODEL_DIR` 指到任意目录。

桥接只写入目标目录（`$MINERU_HOME/models/MinerU2.5-Pro-2605-1.2B`），**不会写进源目录**，因为平台挂载可能是只读的；权重按条目软链而不复制，避免把几 GB 模型再拷一份。目录内缺少 `config.json` 时视为「还不是权重」，会给出明确错误而不是当成已就绪。

小模型包（版面、OCR、公式、表格，仓库名 `MinerU-4_models_torch`）是引擎的固定资产，通常**烧进镜像**：

```bash
mineru-kit models download MinerU-4_models_torch -s modelscope
```

按仓库名下载只取该仓库；用 `--tier standard` 会连 VLM 权重一起下，托管部署不需要那样做。

## 健康检查

`GET /health` 在权重就绪时返回 200，否则返回 503 并把 `model_ready` 置为 `false`：

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

平台探针拿不到鉴权头，所以配置了 `--api-key` 时这个路由仍然免鉴权。副本在权重可读之前不应该被判定为就绪，因此这里按真实状态返回，而不是固定 200。

## Playground

页面内置两个示例文档（`/demo/demo1.pdf`、`/demo/demo2.pdf`），点一下即可试，不必先自备文件。

- **解析**页签：选文件或点内置示例，选档位（`flash` / `basic` / `standard` / `advanced`）、OCR 模式与页码范围，结果区显示 Markdown，可复制或下载。
- **API** 页签：内嵌 `/docs` 的 Swagger UI，可以直接在页面上调一次 `/v1/file_parse`。
- 页面读 `?lang=` 与 `?token=`：前者跟随平台语言切换中英文，后者勾选「使用我的访问令牌」后作为 `Authorization` 头发出。

静态资源带 `Cache-Control: no-cache`。它们随引擎镜像变化，若被浏览器启发式缓存，升级后会继续渲染旧页面，现象难以从外部定位。

## Docker

镜像只烧入小模型包，VLM 权重留给平台挂载：

```bash
docker build -t mineru:4.0.12-cu129 -f docker/china/Dockerfile.mineru .
docker run --gpus all --shm-size 32g --ipc=host \
  -p 8000:8000 \
  -v /path/to/weights:/mnt/models/model:ro \
  mineru:4.0.12-cu129
```

镜像的入口就是 `mineru-kit serve --host 0.0.0.0 --port 8000 --tier standard`，并设好 `MINERU_MODEL_DIR=/mnt/models/model`。

## 继续阅读

- [Docker 部署](docker_deployment.md)
- [SDK 与 API](../usage/sdk_api.md)
- [模型下载与配置](../usage/model_source.md)

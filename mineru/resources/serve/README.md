MinerU Playground 与单端口服务
==============================

`mineru-kit serve` 把**解析 API、接口文档和 Playground 页面收在同一个端口**上，供
托管平台以单端口方式暴露；也可以脱离平台独立运行。本目录是那个页面的前端资源与
它用到的接口文档。

平台的推理代理（rproxy）会剥掉自己的路径前缀再转发，所以页面与规格一律用**相对
地址**引用自身资源；绝对地址会指向平台本身而不是本服务。

路由
----

| 路由 | 用途 |
| --- | --- |
| `/` | Playground：解析页签 + API 页签 |
| `/health` | 健康检查，供平台探针使用（不鉴权） |
| `/config` | 页面启动配置：版本、内置示例清单、双语规格地址 |
| `/render` | 把 `middle_json` 渲染成带格式的 HTML，并返回区块几何（供双向高亮） |
| `/download` | 从结果归档就地转换 HTML / LaTeX / DOCX / EPUB / PDF |
| `/openapi` | 按 `lang` 返回中英文规格（本页说明的重点） |
| `/v1/*` | MinerU V1 解析 API |
| `/docs`、`/openapi.json` | Swagger UI 与 FastAPI 原生规格 |
| `/demo/*` | 内置示例文档 |

页面参数
--------

- `?lang=zh|en`：页面文案与 API 规格同时切换。两者读同一个判断（`i18n.js` 的
  `resolveLanguage`），所以不会出现「页面中文、文档英文」的错配。
- `?token=<bearer>`：带上后「使用我的访问令牌」默认勾选；勾选状态下该 token 会
  作为 `Authorization` 头发给解析接口，并注入 API 页签的「试一试」请求与代码示例。

令牌在**未勾选时会保留 `YOUR_TOKEN` 占位符**，而不是替换成空串——替换成空串会在
示例里留下悬空的 `Bearer `。

接口文档的双语与代码示例
------------------------

规格不是手写的，而是由 [scripts/export_openapi_specs.py](../../../scripts/export_openapi_specs.py)
从运行时 schema 生成：

```bash
python3 scripts/export_openapi_specs.py
```

- **代码是唯一事实来源**：脚本调 `create_app(...).openapi()` 取真实 schema，避免
  手写规格与代码漂移。
- **中文文案**来自 `openapi.i18n.json`（英文原文 → 中文）。未命中的字符串**回落英文**，
  所以新增接口漏翻只会显示英文，不会让生成失败。
- **代码示例**由脚本推导，覆盖全部接口的 Python / JavaScript / cURL 三种；上传类接口
  按 multipart 与 octet-stream 分别给出。
- 产物 `openapi.zh.yaml` / `openapi.en.yaml` 随包分发（`pyproject.toml` 的
  `"mineru" = ["resources/**"]` 已覆盖），由 `/openapi` 读取并替换
  `SERVER_URL` / `YOUR_TOKEN` 两个占位符。

改接口后要重新生成，否则签入的 YAML 会落后于代码；`tests/unittest/test_kit_serve.py`
里有断言把这件事钉住（双语规格的 `paths` 必须与 `/openapi.json` 一致、示例必须三语言
齐备、公开接口不得在示例里带凭据）。

公开接口
--------

服务端的鉴权中间件放行 `/v1/health`、`/v1/tiers`、`/v1/models` 与 `/v1/models/{model}`。
生成脚本据此把这几个操作的 `security` 置为 `[]`（OpenAPI 里表示「无需认证」），并把
它们代码示例里的 `Authorization` 头去掉——公开接口的示例带令牌会教错读者。

前端资源
--------

| 文件 | 用途 |
| --- | --- |
| `index.html` | 页面骨架：两个页签与控件 |
| `app.mjs` | 解析流程、结果渲染、下载菜单、RapiDoc 挂载 |
| `i18n.js` | 页面文案（中/英）与 `?lang=` 解析 |
| `source-viewer.mjs` | 源文档预览与双向高亮 |
| `rapidoc-min-9.3.8.js` | 改过的 RapiDoc 9.3.8，见下节 |
| `openapi.i18n.json` | 规格的中文翻译表 |

RapiDoc 的改动
--------------

`rapidoc-min-9.3.8.js` 是 RapiDoc 9.3.8 加了一段 `i18n overlay`（在文件末尾），
**最新版本以 `csghub-server/docker/inference/template/` 为准**，`asr`、`chatterbox-tts`
与本目录用的是同一份，改动后要一起同步。

- `mapZh`：英文 → 中文的界面词条表。
- `replaceTexts`：遍历文本节点。`TRY` / `CLEAR` / `FILL EXAMPLE` 等按钮渲染在嵌套
  自定义元素（`api-request` / `api-response`）**自己的 shadow root** 里，只走 `rapi-doc`
  一层够不到，所以遍历要递归下钻每个 shadow root。
- `observe`：**每个 shadow root 各挂一个 MutationObserver**。MutationObserver 不跨
  shadow 边界；observer 必须常驻，因为 RapiDoc 每次切换接口都会重渲染。
- 只对中文生效：`?lang=en` 时直接 return。

API 页签的展示取舍
------------------

- `show-info="false"`：不渲染引擎的整体介绍与 Authentication 折叠区。每个操作鉴权
  方式相同，整体介绍对「这个接口怎么调」没有帮助。
- `allow-authentication="false"`：同上，去掉逐操作的认证区块。
- `schema-style="table"`、`show-curl-before-try="true"`、`response-area-height="300"`：
  与其它引擎的页面保持一致。
- 代码示例的 `lang` 决定高亮：RapiDoc 按 `lang` 查它内置的 Prism 词表，那份词表有
  `python` / `javascript` / `bash` / `sh` / `shell`，**没有 `curl`**，所以 cURL 示例写
  `lang: shell`（label 仍写 cURL）。

自测
----

```bash
mineru-kit serve --allow-download --port 8000

curl -s http://127.0.0.1:8000/ | head -3
curl -s 'http://127.0.0.1:8000/openapi?lang=zh' | head -5
curl -s 'http://127.0.0.1:8000/openapi?lang=en' | head -5
# 占位符替换
curl -s 'http://127.0.0.1:8000/openapi?lang=zh&SERVER_URL=http://127.0.0.1:8000&token=secret' | grep -c secret
```

页面上逐项确认：API 页签无整体介绍与 Authentication 区块、TRY / CLEAR /
FILL EXAMPLE 已翻译、代码示例三语言可切换且有高亮、勾选与取消「使用我的访问令牌」
时代码示例里的 token 随之出现与消失。

静态资源带 `Cache-Control: no-cache`：它们随引擎镜像变化，若被浏览器启发式缓存，
升级后会继续渲染旧页面，现象难以从外部定位。

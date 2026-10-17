#!/usr/bin/env python3
# Copyright 2026 Kube AI Hub.
"""把运行时 OpenAPI 文档导出为 Playground 使用的双语 YAML。

Playground 的 API 页签按 ``?lang=`` 加载 ``openapi.zh.yaml`` / ``openapi.en.yaml``，
而不是直接读 FastAPI 的 ``/openapi.json``：这两种语言要能在 RapiDoc 里整份切换，
且要带上 ``x-code-samples``（RapiDoc 用它渲染可复制的 Python / JavaScript / curl 示例），
这些都是展示层的东西，不该塞回接口代码。

代码是唯一事实来源，所以 spec 由本脚本生成而不是手写。改接口后重新运行：

    python3 scripts/export_openapi_specs.py

中文文案取自 ``mineru/resources/serve/openapi.i18n.json``。未命中的字符串回落
英文，所以漏翻只会显示英文，不会让生成失败。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mineru.parser import api_server  # noqa: E402
from mineru.parser.task_api import MAX_TASK_FILE_BYTES  # noqa: E402

SERVE_DIR = ROOT / "mineru/resources/serve"
I18N_PATH = SERVE_DIR / "openapi.i18n.json"

#: Placeholders the server substitutes per request, matching the other engines.
SERVER_URL_PLACEHOLDER = "SERVER_URL"
TOKEN_PLACEHOLDER = "YOUR_TOKEN"

#: Placeholder values for string fields whose shape is known, so a generated
#: sample can be pasted and run rather than filled in first.
_STRING_EXAMPLES: dict[str, str] = {
    "File Id": "file-0cf8b284ab9934cb7dfb68e0",
    "Secret": "shared-secret",
}

#: The one API key scheme this server exposes. RapiDoc needs the id to attach a
#: token to "Try" requests, and the code samples carry the same header.
SECURITY_SCHEME = "HTTPBearer"

#: Operations the server answers without a credential, mirroring the auth
#: middleware's whitelist (`_PUBLIC_PATHS` plus the `/v1/models/` prefix in
#: `api_server`). Declaring `security: []` on them keeps the rendered docs
#: honest: a reader otherwise assumes every call needs a token, and RapiDoc
#: would attach one to their "Try" requests too.
PUBLIC_OPERATIONS: frozenset[tuple[str, str]] = frozenset(
    {
        ("get", "/v1/health"),
        ("get", "/v1/tiers"),
        ("get", "/v1/models"),
        ("get", "/v1/models/{model}"),
    }
)

_HTTP_METHODS = ("get", "post", "put", "delete", "patch")


def build_spec() -> dict[str, Any]:
    """Return the live spec with the display-only bits the page needs."""
    application = api_server.create_app(tier="standard", preload_models=False)
    spec = application.openapi()

    # The page renders its own header and is embedded in a platform that
    # already authenticated the user, so the engine's overall description and
    # the security block are noise: every operation authenticates the same way.
    spec.pop("security", None)
    info = spec.setdefault("info", {})
    info.pop("description", None)

    # A single placeholder server: the page passes the real origin it was
    # opened from, so the same file works directly and behind a proxy prefix.
    spec["servers"] = [
        {
            "url": SERVER_URL_PLACEHOLDER,
            "description": "API Server",
        }
    ]

    mark_public_operations(spec)
    return spec


def mark_public_operations(spec: dict[str, Any]) -> None:
    """Clear the security requirement on operations that need no credential.

    An empty list means "no authentication required", which is what the server
    actually does for these routes.
    """
    for (method, path) in PUBLIC_OPERATIONS:
        operation = (spec.get("paths") or {}).get(path, {}).get(method)
        if operation is None:
            continue
        operation["security"] = []


def translate(value: str, table: dict[str, str]) -> str:
    """Return the translation for one string, or the original when unmapped."""
    return table.get(value, value)


def localize(spec: dict[str, Any], table: dict[str, str]) -> dict[str, Any]:
    """Translate every user-visible string in a copy of the spec.

    Field names, enum values, media types and placeholders stay as they are:
    they are part of the contract, and translating them would make the examples
    wrong.
    """
    localized = json.loads(json.dumps(spec))

    for path_item in localized.get("paths", {}).values():
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS:
                continue
            for key in ("summary", "description"):
                if operation.get(key):
                    operation[key] = translate(operation[key], table)
            body = operation.get("requestBody") or {}
            if body.get("description"):
                body["description"] = translate(body["description"], table)
            for parameter in operation.get("parameters", []):
                if parameter.get("description"):
                    parameter["description"] = translate(parameter["description"], table)
            for response in (operation.get("responses") or {}).values():
                if isinstance(response, dict) and response.get("description"):
                    response["description"] = translate(response["description"], table)

    for tag in localized.get("tags") or []:
        if tag.get("description"):
            tag["description"] = translate(tag["description"], table)

    schemas = (localized.get("components") or {}).get("schemas") or {}
    for schema in schemas.values():
        for prop in (schema.get("properties") or {}).values():
            if prop.get("description"):
                prop["description"] = translate(prop["description"], table)

    return localized


def _example_for(schema: dict[str, Any], schemas: dict[str, Any], depth: int = 0) -> Any:
    """Build a request example from a schema, preferring declared examples.

    Depth is capped because the source schemas are recursive (a job result
    contains a file result which contains an error detail). A request body needs
    a handful of levels — body ref -> object -> array -> entry ref -> object ->
    discriminated source ref -> branch object -> its properties — so the cap
    sits comfortably above that while still stopping a cycle.
    """
    if depth > 9 or not isinstance(schema, dict):
        return None
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        return _example_for(schemas.get(name, {}), schemas, depth + 1)
    for key in ("example", "examples", "default"):
        if schema.get(key) is not None:
            value = schema[key]
            if isinstance(value, list) and value:
                # One level of alternatives: ["a"] -> "a", [["a","b"]] -> ["a","b"].
                if schema.get("type") == "array":
                    return value[0] if isinstance(value[0], list) else value
                return value[0]
            return value
    if "oneOf" in schema or "anyOf" in schema:
        branches = schema.get("oneOf") or schema.get("anyOf")
        # The discriminator mapping is alphabetical, which would put file_id
        # last; the declared order is the one the API documents first.
        for branch in branches:
            resolved = _example_for(branch, schemas, depth + 1)
            if resolved is not None:
                return resolved
        return None
    if "allOf" in schema:
        merged: dict[str, Any] = {}
        for part in schema["allOf"]:
            resolved = _example_for(part, schemas, depth + 1)
            if isinstance(resolved, dict):
                merged.update(resolved)
        return merged or None
    kind = schema.get("type")
    if kind == "object" or "properties" in schema:
        result: dict[str, Any] = {}
        for name, prop in (schema.get("properties") or {}).items():
            value = _example_for(prop, schemas, depth + 1)
            if value is not None:
                result[name] = value
        return result or None
    if kind == "array":
        item = _example_for(schema.get("items") or {}, schemas, depth + 1)
        return [item] if item is not None else []
    if kind == "string":
        # A few fields have a recognisable shape, and a placeholder there makes
        # the sample copy-pasteable instead of obviously broken.
        return _STRING_EXAMPLES.get(schema.get("title") or "", "string")
    if kind == "integer":
        return 0
    if kind == "number":
        return 0.0
    if kind == "boolean":
        return False
    return None


def _body_example(operation: dict[str, Any], schemas: dict[str, Any]) -> Any:
    """Return the JSON example for an operation's request body, if it has one."""
    content = ((operation.get("requestBody") or {}).get("content") or {})
    json_body = content.get("application/json")
    if not json_body:
        return None
    return _example_for(json_body.get("schema") or {}, schemas)


def _example_value(schema: dict[str, Any]) -> Any:
    """Return the best example for a parameter's schema.

    ``examples`` on a scalar schema is a list of alternatives, so the first one
    is the pick; on an array schema the outer list is also alternatives, and
    the inner list holds the values. Both shapes collapse to one value here,
    and the caller repeats the parameter for arrays.
    """
    for key in ("examples", "example", "default"):
        value = schema.get(key)
        if value is None:
            continue
        if isinstance(value, list) and value:
            # One level of alternatives: [["a","b"]] -> ["a","b"], ["a"] -> "a".
            if schema.get("type") == "array" and isinstance(value[0], list):
                return value[0]
            if schema.get("type") != "array":
                return value[0]
        return value
    return None


def _query_pairs(
    parameters: list[dict[str, Any]],
    *,
    raw_upload: bool,
) -> list[tuple[str, str]]:
    """Return (name, value) pairs for the query parameters, examples first.

    Array parameters repeat their name once per value, which is what the API
    expects; a Python-style list literal would fail if pasted as-is. Parameters
    that only apply to raw uploads are left out of the other samples, and
    Content-Length is omitted entirely because every client sets it itself.
    """
    pairs: list[tuple[str, str]] = []
    for parameter in parameters:
        if parameter.get("in") != "query":
            continue
        name = parameter["name"]
        description = parameter.get("description") or ""
        if name == "Content-Length" or (description.startswith("Raw uploads only") and not raw_upload):
            continue
        value = _example_value(parameter.get("schema") or {})
        if value is None:
            pairs.append((name, ""))
            continue
        values = value if isinstance(value, list) else [value]
        if not values:
            values = [""]
        for entry in values:
            pairs.append((name, str(entry)))
    return pairs


def _query_string(pairs: list[tuple[str, str]]) -> str:
    """Join query pairs into a URL-encoded query string."""
    return "&".join(f"{quote(str(name), safe='')}={quote(str(value), safe='')}" for name, value in pairs)


def _sample_url(
    path: str,
    parameters: list[dict[str, Any]],
    *,
    raw_upload: bool = False,
) -> str:
    """Return the URL for a sample, with query parameters already applied.

    Query parameters go into the URL rather than a per-language params object:
    the same shape then reads correctly in all three languages, and the
    array-valued parameters repeat their name the way the API expects.
    """
    url = f"{SERVER_URL_PLACEHOLDER}{path}"
    query = _query_pairs(parameters, raw_upload=raw_upload)
    return f"{url}?{_query_string(query)}" if query else url


def _auth_line(*, required: bool, language: str) -> str:
    """Return the credential line for a sample, or nothing for public routes.

    A public operation's sample must not carry an Authorization header: pasted
    as-is it would be rejected by nothing, but it would teach the reader that
    the call needs a token it does not.
    """
    if not required:
        return ""
    if language == "python":
        return '"Authorization": "Bearer YOUR_TOKEN",'
    if language == "javascript":
        return 'Authorization: "Bearer YOUR_TOKEN",'
    return '  -H "Authorization: Bearer YOUR_TOKEN"'


def _python_headers(auth: str, *, extra: str = "") -> list[str]:
    """Return the `headers = {...}` block for a Python sample.

    The credential line already carries its own quotes, so the block is built
    from parts rather than by interpolating into another quoted string.
    """
    if not auth and not extra:
        return []
    lines = ["headers = {"]
    if auth:
        lines.append(f"    {auth}")
    if extra:
        lines.append(f"    {extra}")
    lines.append("}")
    return lines


def _python_sample(
    path: str,
    method: str,
    parameters: list[dict[str, Any]],
    body: Any,
    *,
    multipart: bool = False,
    raw: bool = False,
    authenticated: bool = True,
) -> str:
    url = _sample_url(path, parameters, raw_upload=raw)
    auth = _auth_line(required=authenticated, language="python")
    lines = ["import requests", ""]
    if multipart:
        lines.append(f'url = "{url}"')
        lines += _python_headers(auth)
        lines.append('files = {"files": ("document.pdf", open("document.pdf", "rb"), "application/pdf")}')
        lines.append("")
        call = f"requests.{method}(url, files=files"
        call += ", headers=headers)" if auth else ")"
        lines.append(f"response = {call}")
    elif raw:
        lines.append(f'url = "{url}"')
        lines += _python_headers(auth, extra='"Content-Type": "application/octet-stream",')
        lines.append('with open("document.pdf", "rb") as source:')
        call = f"requests.{method}(url, data=source"
        call += ", headers=headers)" if auth else ")"
        lines.append(f"    response = {call}")
    elif body is not None:
        lines.append(f'url = "{url}"')
        lines += _python_headers(auth)
        lines.append(f"payload = {json.dumps(body, indent=4, ensure_ascii=False)}")
        lines.append("")
        call = f"requests.{method}(url, json=payload"
        call += ", headers=headers)" if auth else ")"
        lines.append(f"response = {call}")
    else:
        lines.append(f'url = "{url}"')
        lines += _python_headers(auth)
        call = f"requests.{method}(url"
        call += ", headers=headers)" if auth else ")"
        lines.append(f"response = {call}")
    lines += ["", "print(response.status_code)", "print(response.json())"]
    return "\n".join(lines)


def _javascript_sample(
    path: str,
    method: str,
    parameters: list[dict[str, Any]],
    body: Any,
    *,
    multipart: bool = False,
    raw: bool = False,
    authenticated: bool = True,
) -> str:
    url = _sample_url(path, parameters, raw_upload=raw)
    auth = _auth_line(required=authenticated, language="javascript")
    headers_block = ["  headers: {", f"    {auth}", "  },"] if auth else []
    lines = [f'const url = "{url}";']
    if multipart:
        lines += [
            "const form = new FormData();",
            'form.append("files", fileInput.files[0], "document.pdf");',
            "",
            "const response = await fetch(url, {",
            f'  method: "{method.upper()}",',
            *headers_block,
            "  body: form,",
            "});",
        ]
    elif raw:
        lines += [
            "const file = document.querySelector('input[type=\"file\"]').files[0];",
            "",
            "const response = await fetch(url, {",
            f'  method: "{method.upper()}",',
            *(["  headers: {", f"    {auth}", '    "Content-Type": "application/octet-stream",', "  },"] if auth else ['  headers: { "Content-Type": "application/octet-stream" },']),
            "  body: file,",
            "});",
        ]
    elif body is not None:
        lines += [
            f"const payload = {json.dumps(body, indent=2, ensure_ascii=False)};",
            "",
            "const response = await fetch(url, {",
            f'  method: "{method.upper()}",',
            *(["  headers: {", '    "Content-Type": "application/json",', f"    {auth}", "  },"] if auth else ['  headers: { "Content-Type": "application/json" },']),
            "  body: JSON.stringify(payload),",
            "});",
        ]
    else:
        lines += [
            "",
            "const response = await fetch(url, {",
            f'  method: "{method.upper()}",',
            *headers_block,
            "});",
        ]
    lines += ["", "const data = await response.json();", "console.log(response.status, data);"]
    return "\n".join(lines)


def _curl_sample(
    path: str,
    method: str,
    parameters: list[dict[str, Any]],
    body: Any,
    *,
    multipart: bool = False,
    raw: bool = False,
    authenticated: bool = True,
) -> str:
    url = _sample_url(path, parameters, raw_upload=raw)
    lines = [f"curl -X {method.upper()} '{url}' \\"]
    if multipart:
        if authenticated:
            lines.append('  -H "Authorization: Bearer YOUR_TOKEN" \\')
        lines.append('  -F "files=@document.pdf"')
    elif raw:
        if authenticated:
            lines.append('  -H "Authorization: Bearer YOUR_TOKEN" \\')
        lines.append('  -H "Content-Type: application/octet-stream" \\')
        lines.append("  --data-binary @document.pdf")
    elif body is not None:
        if authenticated:
            lines.append('  -H "Authorization: Bearer YOUR_TOKEN" \\')
        lines.append('  -H "Content-Type: application/json" \\')
        lines.append(f"  -d '{json.dumps(body, ensure_ascii=False)}'")
    elif authenticated:
        lines.append('  -H "Authorization: Bearer YOUR_TOKEN"')
    else:
        # A bare "curl -X GET 'url' \" would leave a dangling continuation.
        lines[-1] = lines[-1].rstrip(" \\")
    return "\n".join(lines)


def _code_samples(
    path: str,
    method: str,
    operation: dict[str, Any],
    schemas: dict[str, Any],
) -> list[dict[str, str]]:
    """Build the Python / JavaScript / curl samples RapiDoc renders as tabs."""
    parameters = operation.get("parameters") or []
    body = _body_example(operation, schemas)
    content = ((operation.get("requestBody") or {}).get("content") or {})
    multipart = "multipart/form-data" in content
    raw = "application/octet-stream" in content and not multipart
    authenticated = (method, path) not in PUBLIC_OPERATIONS

    samples = [
        {
            "lang": "python",
            "label": "Python",
            "source": _python_sample(
                path, method, parameters, body, multipart=multipart, raw=raw, authenticated=authenticated
            ),
        },
        {
            "lang": "javascript",
            "label": "JavaScript",
            "source": _javascript_sample(
                path, method, parameters, body, multipart=multipart, raw=raw, authenticated=authenticated
            ),
        },
        {
            # RapiDoc picks its highlighter by `lang` from the Prism bundle it
            # ships, which defines shell but not curl; the label still says cURL.
            "lang": "shell",
            "label": "cURL",
            "source": _curl_sample(
                path, method, parameters, body, multipart=multipart, raw=raw, authenticated=authenticated
            ),
        },
    ]
    return samples


def attach_code_samples(spec: dict[str, Any]) -> None:
    """Write ``x-code-samples`` onto every operation.

    RapiDoc reads either ``x-code-samples`` or ``xCodeSamples``; the kebab-case
    form is what the other engines in this repository use, so the page renders
    the same way across engines.
    """
    schemas = (spec.get("components") or {}).get("schemas") or {}
    for path, path_item in spec.get("paths", {}).items():
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS:
                continue
            operation["x-code-samples"] = _code_samples(path, method, operation, schemas)


def write_yaml(spec: dict[str, Any], target: Path) -> None:
    """Write a spec as YAML with stable key order and readable Unicode."""
    target.write_text(
        yaml.safe_dump(spec, allow_unicode=True, sort_keys=False, width=120),
        encoding="utf-8",
    )


def main() -> None:
    """Generate the English and Chinese specs the Playground serves."""
    table = json.loads(I18N_PATH.read_text(encoding="utf-8"))["zh"]
    spec = build_spec()
    attach_code_samples(spec)

    english = SERVE_DIR / "openapi.en.yaml"
    chinese = SERVE_DIR / "openapi.zh.yaml"
    write_yaml(spec, english)
    write_yaml(localize(spec, table), chinese)

    operations = sum(
        1
        for path_item in spec["paths"].values()
        for method in path_item
        if method in _HTTP_METHODS
    )
    print(f"Wrote {english.relative_to(ROOT)} and {chinese.relative_to(ROOT)} ({operations} operations)")
    print(f"Upload limit referenced in samples: {MAX_TASK_FILE_BYTES} bytes")


if __name__ == "__main__":
    main()

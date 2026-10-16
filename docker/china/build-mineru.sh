#!/usr/bin/env bash
# Build and push the MinerU serving engine image.
#
# Usage:
#   ./docker/china/build-mineru.sh [REGISTRY] [TAG]
#
# Defaults target the ACR the model platform pulls from. The image is amd64
# only: the platform's inference nodes are amd64, and building an arm64 variant
# as well would double the push size for no deployment benefit.
#
# The build is heavy (a CUDA base image plus MinerU's Torch stack), so on a
# machine with a tight disk run it where the disk is, not necessarily locally:
# pass PIP_INDEX_URL to pick a mirror the build host can reach.
set -euo pipefail

REGISTRY="${1:-watering-ai-registry.cn-shanghai.cr.aliyuncs.com/kube-ai-hub}"
TAG="${2:-4.0.12-cu130}"
IMAGE="${REGISTRY}/opencsghq/mineru:${TAG}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

echo "Building ${IMAGE}"

# A separate builder avoids clobbering the state of whatever buildx context is
# currently selected.
if ! docker buildx inspect mineru-builder >/dev/null 2>&1; then
    docker buildx create --name mineru-builder --driver docker-container --bootstrap
fi

DOCKER_BUILDKIT=1 BUILDX_NO_DEFAULT_ATTESTATIONS=1 \
    docker buildx build \
        --builder mineru-builder \
        --platform linux/amd64 \
        --build-arg "VLLM_IMAGE=${VLLM_IMAGE:-watering-ai-registry.cn-shanghai.cr.aliyuncs.com/kube-ai-hub/vllm/vllm-openai:v0.30.0}" \
        --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}" \
        -f docker/china/Dockerfile.mineru \
        -t "${IMAGE}" \
        --push \
        .

echo "Pushed ${IMAGE}"

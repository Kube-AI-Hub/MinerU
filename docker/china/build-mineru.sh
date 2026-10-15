#!/usr/bin/env bash
# Build and push the MinerU serving engine image.
#
# Usage:
#   ./docker/china/build-mineru.sh [REGISTRY] [TAG]
#
# Defaults target the ACR the model platform pulls from. The image is amd64
# only: the platform's inference nodes are amd64, and building an arm64 variant
# as well would double the push size for no deployment benefit.
set -euo pipefail

REGISTRY="${1:-watering-ai-registry.cn-shanghai.cr.aliyuncs.com/kube-ai-hub}"
TAG="${2:-4.0.12-cu129}"
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
        --build-arg "VLLM_IMAGE=${VLLM_IMAGE:-docker.m.daocloud.io/vllm/vllm-openai:v0.21.0-cu129}" \
        -f docker/china/Dockerfile.mineru \
        -t "${IMAGE}" \
        --push \
        .

echo "Pushed ${IMAGE}"

#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_NAME=${IMAGE_NAME:-"morchv/tasklist"}
IMAGE_VERSION=${IMAGE_VERSION:-"latest"}

REGISTRY_URL=${REGISTRY_URL:-"gitea.home.morch.al"}

RELEASE=false
REBUILD=false
for arg in "$@"; do
  case $arg in
    --release)
      RELEASE=true
      ;;
    --rebuild)
      REBUILD=true
      ;;
  esac
done

DOCKER_BUILD_ARGS=()
if [ "$REBUILD" = true ]; then
  DOCKER_BUILD_ARGS+=(--no-cache)
fi

echo "Building $IMAGE_NAME version $IMAGE_VERSION"
docker build "${DOCKER_BUILD_ARGS[@]}" -t "$IMAGE_NAME:$IMAGE_VERSION" "$ROOT_DIR"

docker tag "$IMAGE_NAME:$IMAGE_VERSION" "$IMAGE_NAME:latest"
docker tag "$IMAGE_NAME:$IMAGE_VERSION" "$REGISTRY_URL/$IMAGE_NAME:$IMAGE_VERSION"
docker tag "$IMAGE_NAME:$IMAGE_VERSION" "$REGISTRY_URL/$IMAGE_NAME:latest"

if [ "$RELEASE" = true ]; then
  echo "Pushing images to registry..."
  docker push "$REGISTRY_URL/$IMAGE_NAME:$IMAGE_VERSION"
  docker push "$REGISTRY_URL/$IMAGE_NAME:latest"
fi

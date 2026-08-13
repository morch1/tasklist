#!/bin/bash

set_env_var() {
    local var_name="$1"
    local var_value="$2"
    local env_file="./.devcontainer/.env"
    grep -q "^${var_name}=" "$env_file" 2>/dev/null || echo "${var_name}=${var_value}" >> "$env_file"
}

init () {
    basename="$(basename "$(pwd)")"
    set_env_var "COMPOSE_PROJECT_NAME" "pi-box-${basename}"
    set_env_var "WORKSPACE" "$basename"
}

postCreate() {
    [ -f .env.example ] && [ ! -f .env ] && cp .env.example .env || true
    [ -f requirements.txt ] && pip install -r requirements.txt || true
    [ -f pyproject.toml ] && uv sync || true
    [ -f package.json ] && npm install || true
}

$1

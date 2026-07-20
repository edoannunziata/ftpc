#!/usr/bin/env bash
set -euo pipefail

repo="${FTPC_REPO:-edoannunziata/ftpc}"
tag="${FTPC_TAG:-${FTPC_VERSION:-}}"
install_dir="${FTPC_INSTALL_DIR:-/usr/local/bin}"

case "$(uname -s)" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

download() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$1" -o "$2"
  else
    curl -fsSL "$1" -o "$2"
  fi
}

download_github_api() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      "$1" -o "$2"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      "$1" -o "$2"
  fi
}

resolve_latest_tag() {
  local release_json="${tmp_dir}/release.json"
  local resolved_tag

  if ! download_github_api \
    "https://api.github.com/repos/${repo}/releases/latest" \
    "$release_json" 2>/dev/null; then
    download_github_api \
      "https://api.github.com/repos/${repo}/releases?per_page=1" \
      "$release_json"
  fi

  resolved_tag="$(awk -F '"' '/"tag_name"[[:space:]]*:/ { print $4; exit }' "$release_json")"
  if [ -z "$resolved_tag" ]; then
    echo "No published release was found for ${repo}" >&2
    exit 1
  fi

  printf '%s\n' "$resolved_tag"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "Required command not found: sha256sum or shasum" >&2
    return 1
  fi
}

install_binary() {
  local source="$1"
  local target_dir="$2"
  local target="${target_dir}/ftpc"

  if [ ! -d "$target_dir" ]; then
    if ! mkdir -p "$target_dir" 2>/dev/null; then
      if ! command -v sudo >/dev/null 2>&1; then
        echo "Cannot create ${target_dir}; rerun with FTPC_INSTALL_DIR set to a writable directory" >&2
        exit 1
      fi
      sudo mkdir -p "$target_dir"
    fi
  fi

  if [ -w "$target_dir" ]; then
    install -m 0755 "$source" "$target"
  else
    if ! command -v sudo >/dev/null 2>&1; then
      echo "Cannot write to ${target_dir}; rerun with FTPC_INSTALL_DIR set to a writable directory" >&2
      exit 1
    fi
    sudo install -m 0755 "$source" "$target"
  fi
}

require_command curl
require_command tar
require_command awk
require_command install
require_command mktemp

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

if [ -z "$tag" ] || [ "$tag" = "latest" ]; then
  tag="$(resolve_latest_tag)"
  echo "Resolved latest release: ${tag}"
fi

case "$tag" in
  master | master-latest)
    echo "Refusing to install from mutable tag: $tag" >&2
    echo "Set FTPC_TAG to an immutable release tag instead" >&2
    exit 1
    ;;
esac

asset="ftpc-${platform}-${arch}.tar.gz"
base_url="https://github.com/${repo}/releases/download/${tag}"

archive="${tmp_dir}/${asset}"
checksums="${tmp_dir}/checksums.txt"

echo "Downloading ${repo} ${tag} for ${platform}-${arch}"
download "${base_url}/${asset}" "$archive"
download "${base_url}/checksums.txt" "$checksums"

expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "$checksums")"
if [ -z "$expected" ]; then
  echo "Checksum for ${asset} was not found in checksums.txt" >&2
  exit 1
fi

actual="$(sha256_file "$archive")"
if [ "$actual" != "$expected" ]; then
  echo "Checksum mismatch for ${asset}" >&2
  exit 1
fi

tar -xzf "$archive" -C "$tmp_dir"
binary="${tmp_dir}/ftpc-${platform}-${arch}/ftpc"
if [ ! -x "$binary" ]; then
  echo "Downloaded package did not contain an executable ftpc binary" >&2
  exit 1
fi

install_binary "$binary" "$install_dir"

echo "ftpc installed to ${install_dir}/ftpc"

#!/usr/bin/env bash
set -euo pipefail

repo="${FTPC_REPO:-edoannunziata/ftpc}"
tag="${FTPC_TAG:-${FTPC_VERSION:-master-latest}}"
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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "No SHA-256 tool found; skipping checksum verification" >&2
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

asset="ftpc-${platform}-${arch}.tar.gz"
base_url="https://github.com/${repo}/releases/download/${tag}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

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

actual="$(sha256_file "$archive" || true)"
if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
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

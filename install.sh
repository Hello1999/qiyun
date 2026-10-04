#!/usr/bin/env bash
# Public-source bootstrap. Run a reviewed, fixed commit through sudo bash.
set -Eeuo pipefail
umask 077

QIYUN_REPO=${QIYUN_REPO:-Hello1999/qiyun}
QIYUN_REF=${QIYUN_REF:-v0.1.0}
QIYUN_INSTALL_DIR=${QIYUN_INSTALL_DIR:-/opt/qiyun}
QIYUN_INSTALL_DEPS=${QIYUN_INSTALL_DEPS:-1}
QIYUN_COMMIT=${QIYUN_COMMIT:-}
temporary_dirs=()

die() { printf 'Qiyun: %s\n' "$*" >&2; exit 1; }
cleanup() {
  local path
  for path in "${temporary_dirs[@]}"; do
    # Every entry comes directly from mktemp, never from an install-directory input.
    if [[ -n "$path" && -d "$path" && ! -L "$path" ]]; then rm -rf -- "$path"; fi
  done
}
trap cleanup EXIT
trap 'printf "Qiyun: installation failed at line %s; no success was recorded.\n" "$LINENO" >&2' ERR

[[ $(uname -s) == Linux ]] || die 'This installer supports Linux only.'
case $(uname -m) in x86_64) architecture=amd64 ;; aarch64|arm64) architecture=arm64 ;; *) die 'Supported architectures: amd64 and arm64.' ;; esac
[[ "$QIYUN_REPO" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'QIYUN_REPO must be a GitHub owner/repository name.'
[[ "$QIYUN_REF" =~ ^[a-fA-F0-9]{40}$ || "$QIYUN_REF" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || die 'QIYUN_REF must be a full 40-character commit SHA or a version tag; floating branches are refused.'
[[ -z "$QIYUN_COMMIT" || "$QIYUN_COMMIT" =~ ^[a-fA-F0-9]{40}$ ]] || die 'QIYUN_COMMIT must be a complete commit SHA.'
[[ "$QIYUN_INSTALL_DEPS" == 0 || "$QIYUN_INSTALL_DEPS" == 1 ]] || die 'QIYUN_INSTALL_DEPS must be 0 or 1.'
[[ "$QIYUN_INSTALL_DIR" == /* && "$QIYUN_INSTALL_DIR" != *$'\n'* ]] || die 'QIYUN_INSTALL_DIR must be an absolute Linux path.'
command -v realpath >/dev/null || die 'Install coreutils (realpath) before running this installer.'
[[ ! -L "$QIYUN_INSTALL_DIR" ]] || die 'The installation directory must not be a symbolic link.'
install_dir=$(realpath -m -- "$QIYUN_INSTALL_DIR")
case "$install_dir" in /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/local|/var|/var/lib|/var/tmp) die 'Refusing to use a system directory as the installation directory.' ;; esac
origin="https://github.com/$QIYUN_REPO.git"

# Ignore ambient Git repository/config overrides; never run a local fsmonitor or hook.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_TEMPLATE_DIR GIT_REPLACE_REF_BASE
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1
git_safe() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c http.sslVerify=true "$@"; }

validate_existing() {
  local existing_status index_flags
  [[ -e "$install_dir" ]] || return 0
  [[ -d "$install_dir/.git" && ! -L "$install_dir/.git" ]] || die 'The target already exists and is not a standalone Git checkout. Nothing was replaced.'
  [[ $(git_safe -C "$install_dir" rev-parse --show-toplevel) == "$install_dir" ]] || die 'The target is not its own Git repository.'
  [[ $(git_safe -C "$install_dir" config --get remote.origin.url) == "$origin" ]] || die 'The existing Git origin does not exactly match QIYUN_REPO. Nothing was replaced.'
  existing_status=$(git_safe -C "$install_dir" status --porcelain --untracked-files=all) || die 'Cannot determine the existing checkout status; nothing was replaced.'
  [[ -z "$existing_status" ]] || die 'The checkout has local changes or untracked files. Preserve/review them before retrying; ignored .env/data are left intact.'
  index_flags=$(git_safe -C "$install_dir" ls-files -v) || die 'Cannot verify the existing Git index; nothing was replaced.'
  if grep -qE '^([a-z]|S) ' <<< "$index_flags"; then die 'Assume-unchanged/skip-worktree entries exist; review them before installation.'; fi
}
# Reject unrelated directories before installing any system dependency.
if [[ -e "$install_dir" ]]; then
  [[ -d "$install_dir/.git" && ! -L "$install_dir/.git" ]] || die 'The target already exists and is not a standalone Git checkout. Nothing was replaced.'
  if command -v git >/dev/null; then validate_existing; fi
fi

supported_apt() {
  [[ -f /etc/os-release ]] || die 'Cannot identify Linux distribution; preinstall Git, Docker Engine and Compose v2.'
  os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
  os_version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
  os_codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release | tr -d '"')
  case "$os_id:$os_version" in ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;; *) die 'Automatic dependencies support Ubuntu 22.04/24.04/26.04 and Debian 12/13; preinstall dependencies on other distributions.' ;; esac
  [[ "$os_codename" =~ ^[a-z][a-z0-9]*$ ]] || die 'Missing valid distribution codename.'
  [[ $EUID == 0 ]] || die 'Dependency installation needs root. Use sudo bash, or preinstall dependencies and set QIYUN_INSTALL_DEPS=0.'
  command -v apt-get >/dev/null || die 'apt-get is unavailable; preinstall dependencies.'
}

ensure_dependencies() {
  local need_git=0 need_docker=0 package state query_status deps_tmp key_path source_path
  command -v git >/dev/null || need_git=1
  command -v docker >/dev/null || need_docker=1
  if (( need_git || need_docker )); then
    [[ "$QIYUN_INSTALL_DEPS" == 1 ]] || die 'Git and Docker Engine with Compose v2 are required; dependency installation was disabled.'
    supported_apt
    if (( need_docker )); then
      command -v dpkg-query >/dev/null || die 'Cannot inspect installed container packages; refusing automatic Docker installation.'
      for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc docker-ce docker-ce-cli containerd.io; do
        if state=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null); then :; else
          query_status=$?
          [[ $query_status == 1 ]] || die 'The package database could not be inspected safely; refusing automatic Docker installation.'
          state=''
        fi
        [[ "$state" != installed ]] || die "Existing package $package detected. Refusing to replace container infrastructure; install/configure Docker and Compose manually."
      done
    fi
    printf 'Installing missing prerequisites from the distribution repositories.\n'
    apt_safe update
    if (( need_git )); then apt_safe install -y --no-upgrade --no-remove git ca-certificates curl; else apt_safe install -y --no-upgrade --no-remove ca-certificates curl; fi
    if (( need_docker )); then
      deps_tmp=$(mktemp -d /tmp/qiyun-bootstrap.XXXXXXXX)
      temporary_dirs+=("$deps_tmp")
      curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 "https://download.docker.com/linux/$os_id/gpg" -o "$deps_tmp/docker.asc"
      [[ -s "$deps_tmp/docker.asc" ]] || die 'Docker signing-key download was empty.'
      key_path=/etc/apt/keyrings/qiyun-docker.asc
      source_path=/etc/apt/sources.list.d/qiyun-docker.sources
      printf '# Managed by Qiyun bootstrap: official Docker repository.\nTypes: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: %s\n' "$os_id" "$os_codename" "$architecture" "$key_path" > "$deps_tmp/docker.sources"
      if [[ -e "$key_path" || -L "$key_path" ]]; then [[ ! -L "$key_path" ]] && cmp -s "$key_path" "$deps_tmp/docker.asc" || die "Existing $key_path differs; review it manually."; fi
      if [[ -e "$source_path" || -L "$source_path" ]]; then [[ ! -L "$source_path" ]] && cmp -s "$source_path" "$deps_tmp/docker.sources" || die "Existing $source_path differs; review it manually."; fi
      install -d -m 0755 /etc/apt/keyrings /etc/apt/sources.list.d
      install -m 0644 "$deps_tmp/docker.asc" "$key_path"
      install -m 0644 "$deps_tmp/docker.sources" "$source_path"
      apt_safe update
      apt_safe install -y --no-upgrade --no-remove docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    fi
  fi
  command -v git >/dev/null || die 'Git installation did not complete.'
  command -v docker >/dev/null || die 'Docker installation did not complete.'
  docker compose version >/dev/null 2>&1 || die 'Docker exists but Compose v2 is missing. Install its Compose plugin manually; this installer will not upgrade or replace an existing Engine. See https://docs.docker.com/compose/install/linux/ .'
  docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable or this user lacks access. Existing daemon settings were not changed.'
}

# A curl | bash bootstrap must never let a package prompt read the remaining
# installer source from stdin. Keep modified conffiles and avoid needrestart
# automatically restarting unrelated services while installing prerequisites.
apt_safe() {
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -o Dpkg::Options::=--force-confold "$@" </dev/null
}

ensure_dependencies
parent_dir=$(dirname -- "$install_dir")
mkdir -p -- "$parent_dir"
parent_dir=$(cd -- "$parent_dir" && pwd -P)
install_dir="$parent_dir/$(basename -- "$install_dir")"
[[ ! -L "$install_dir" ]] || die 'The installation directory became a symbolic link.'

validate_existing

# Fetch into a new sibling directory. No checkout/reset/clean is ever performed in
# an existing installation, including when an upstream version differs.
stage=$(mktemp -d "$parent_dir/.qiyun-stage.XXXXXXXX")
temporary_dirs+=("$stage")
git_safe init --quiet "$stage"
git_safe -C "$stage" remote add origin "$origin"
if [[ "$QIYUN_REF" =~ ^[a-fA-F0-9]{40}$ ]]; then
  git_safe -C "$stage" fetch --quiet --depth 1 --no-tags origin "${QIYUN_REF,,}"
  commit=$(git_safe -C "$stage" rev-parse --verify 'FETCH_HEAD^{commit}')
  [[ "${commit,,}" == "${QIYUN_REF,,}" ]] || die 'Fetched commit does not match the requested SHA.'
else
  git_safe -C "$stage" fetch --quiet --depth 1 --no-tags origin "refs/tags/$QIYUN_REF:refs/tags/$QIYUN_REF"
  commit=$(git_safe -C "$stage" rev-parse --verify "refs/tags/$QIYUN_REF^{commit}")
fi
[[ -z "$QIYUN_COMMIT" || "${commit,,}" == "${QIYUN_COMMIT,,}" ]] || die 'The version tag does not resolve to QIYUN_COMMIT.'
git_safe -C "$stage" checkout --quiet --detach "$commit"
[[ -f "$stage/deploy/install.sh" && ! -L "$stage/deploy/install.sh" && -f "$stage/deploy/compose.yaml" && -f "$stage/pnpm-lock.yaml" ]] || die 'The selected source revision is not a complete Qiyun distribution.'

if [[ -e "$install_dir" ]]; then
  validate_existing
  existing_commit=$(git_safe -C "$install_dir" rev-parse --verify HEAD)
  [[ "$existing_commit" == "$commit" ]] || die 'A different version is already installed. Automatic upgrades are not supported: back up data/config, review release changes, and perform an explicit Git/deployment upgrade. The existing checkout was preserved.'
  printf 'Verified existing Qiyun checkout at %s; keeping local ignored configuration and data.\n' "$commit"
else
  mv -T --no-clobber -- "$stage" "$install_dir"
  [[ ! -e "$stage" ]] || die 'The target appeared during installation. No existing directory was overwritten.'
  temporary_dirs[$((${#temporary_dirs[@]} - 1))]=''
  printf 'Installed verified source revision %s to %s.\n' "$commit" "$install_dir"
fi

printf 'Starting the control-plane deployment (%s). Host Agent enrollment remains separate.\n' "$architecture"
if ( : </dev/tty ) 2>/dev/null; then
  bash "$install_dir/deploy/install.sh" </dev/tty
else
  bash "$install_dir/deploy/install.sh" </dev/null
fi
printf 'Qiyun control-plane deployment completed successfully. Source: %s at %s.\n' "$origin" "$commit"

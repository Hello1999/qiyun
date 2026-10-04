#!/usr/bin/env sh
# Installs only the control plane; host enrollment is a separate operation.
set +x
set -eu
umask 077
fail() { printf '%s\n' "Qiyun: $*" >&2; exit 1; }
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v docker >/dev/null 2>&1 || fail 'Docker Engine is required. Install Docker and Compose v2 for your distribution, then rerun.'
docker info >/dev/null 2>&1 || fail 'Docker Engine is unavailable or this user cannot access it.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
docker compose up --help | grep -q -- '--wait-timeout' || fail 'Docker Compose with --wait-timeout support is required.'
test -f "$project_dir/pnpm-lock.yaml" || fail 'Missing lockfile; use a complete checkout.'

# Reject dotenv/mount delimiters. Never source the saved configuration as code.
safe_path() {
  case "$1" in *'
'*|*':'*|*','*|*'$'*|*'`'*|*'"'*|*"'"*|*'\'*|*'#'*) fail 'Installation paths contain unsupported characters.';; esac
}
safe_path "$project_dir"
state_input=${QIYUN_STATE_DIR:-$project_dir/.local/control-install}
safe_path "$state_input"
test ! -L "$state_input" || fail 'State directory must not be a symlink.'
mkdir -p "$state_input"
state_dir=$(CDPATH= cd -- "$state_input" && pwd)
case "$state_dir" in /|/etc|/usr|/var|/tmp|/opt|/home|/root|"${HOME:-/}"|"$project_dir") fail 'Choose a dedicated private state directory.';; esac
chmod 700 "$state_dir"
config=$state_dir/deployment.env
test ! -L "$config" || fail 'Configuration must not be a symlink.'
existing=0
if test -f "$config"; then
  existing=1
  # All required entries must occur exactly once; unknown fields are rejected.
  keys='QIYUN_INSTALL_VERSION QIYUN_SOURCE_DIR QIYUN_STATE_DIR QIYUN_SECRET_DIR QIYUN_PROJECT_NAME QIYUN_CONTROL_IMAGE QIYUN_PORT QIYUN_AGENT_PORT QIYUN_AGENT_BIND QIYUN_AGENT_URL QIYUN_AGENT_HOSTNAMES QIYUN_ALLOWED_ORIGINS QIYUN_DEMO'
  for key in $keys; do
    test "$(grep -c "^$key=" "$config")" = 1 || fail "Invalid saved field: $key"
  done
  while IFS='=' read -r key value; do
    case " $keys " in *" $key "*) export "$key=$value";; *) fail 'Unknown saved configuration entry.';; esac
  done < "$config"
  test "$QIYUN_INSTALL_VERSION" = 1 || fail 'Unsupported installation state version.'
  test "$QIYUN_SOURCE_DIR" = "$project_dir" || fail 'Saved configuration belongs to another checkout.'
  test "$QIYUN_STATE_DIR" = "$state_dir" || fail 'Saved state directory does not match.'
fi
QIYUN_STATE_DIR=$state_dir
QIYUN_SECRET_DIR=$state_dir/secrets
QIYUN_PROJECT_NAME=${QIYUN_PROJECT_NAME:-qiyun}
QIYUN_CONTROL_IMAGE=$QIYUN_PROJECT_NAME-control:local
QIYUN_PORT=${QIYUN_PORT:-4310}
QIYUN_AGENT_PORT=${QIYUN_AGENT_PORT:-4311}
QIYUN_AGENT_BIND=${QIYUN_AGENT_BIND:-127.0.0.1}
QIYUN_AGENT_URL=${QIYUN_AGENT_URL:-https://localhost:$QIYUN_AGENT_PORT}
QIYUN_AGENT_HOSTNAMES=${QIYUN_AGENT_HOSTNAMES:-localhost}
QIYUN_ALLOWED_ORIGINS=${QIYUN_ALLOWED_ORIGINS:-http://localhost:$QIYUN_PORT,http://127.0.0.1:$QIYUN_PORT}
QIYUN_DEMO=${QIYUN_DEMO:-true}
single_line() { case "$1" in *'
'*|*''*) fail 'Configuration must contain single-line values.';; esac; }
for value in "$QIYUN_PROJECT_NAME" "$QIYUN_PORT" "$QIYUN_AGENT_PORT" "$QIYUN_AGENT_URL" "$QIYUN_AGENT_HOSTNAMES" "$QIYUN_ALLOWED_ORIGINS"; do single_line "$value"; done
printf '%s\n' "$QIYUN_PROJECT_NAME" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,49}$' || fail 'Invalid Compose project name.'
for port in "$QIYUN_PORT" "$QIYUN_AGENT_PORT"; do
  case "$port" in ''|*[!0-9]*) fail 'Ports must be decimal integers.';; esac
  test "$port" -ge 1 && test "$port" -le 65535 || fail 'Ports must be between 1 and 65535.'
done
test "$QIYUN_PORT" != "$QIYUN_AGENT_PORT" || fail 'Web and Agent ports must differ.'
case "$QIYUN_AGENT_BIND" in 127.0.0.1|0.0.0.0) ;; *) fail 'Agent bind must be 127.0.0.1 or 0.0.0.0.';; esac
case "$QIYUN_DEMO" in true|false) ;; *) fail 'QIYUN_DEMO must be true or false.';; esac
printf '%s\n' "$QIYUN_AGENT_URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || fail 'Agent URL must be an exact HTTPS origin.'
printf '%s\n' "$QIYUN_AGENT_HOSTNAMES" | grep -Eq '^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$' || fail 'Invalid Agent certificate hostnames.'
printf '%s\n' "$QIYUN_ALLOWED_ORIGINS" | grep -Eq '^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:[0-9]+)?(,(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:[0-9]+)?)*$' || fail 'Origins must be exact HTTPS or loopback HTTP origins.'
export QIYUN_STATE_DIR QIYUN_SECRET_DIR QIYUN_PROJECT_NAME QIYUN_CONTROL_IMAGE QIYUN_PORT QIYUN_AGENT_PORT QIYUN_AGENT_BIND QIYUN_AGENT_URL QIYUN_AGENT_HOSTNAMES QIYUN_ALLOWED_ORIGINS QIYUN_DEMO
unset ARK_API_KEY ARK_API_KEY_FILE
dc() { docker compose --project-directory "$project_dir/deploy" --project-name "$QIYUN_PROJECT_NAME" --env-file "$config" -f "$project_dir/deploy/compose.yaml" "$@"; }

# Refuse to adopt unrelated containers or volumes with the same Compose name.
containers=$(docker ps -aq --filter "label=com.docker.compose.project=$QIYUN_PROJECT_NAME")
for id in $containers; do
  test "$existing" = 1 || fail 'Compose project already exists without this installation state; choose another QIYUN_PROJECT_NAME.'
  owner=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$id")
  test "$owner" = "$project_dir/deploy/compose.yaml" || fail 'Compose project belongs to another checkout; refusing to replace it.'
done
if test "$existing" = 0; then
  test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$QIYUN_PROJECT_NAME")" || fail 'Existing project volumes have no matching installation state; choose another project name.'
  {
    printf 'QIYUN_INSTALL_VERSION=1\nQIYUN_SOURCE_DIR=%s\n' "$project_dir"
    for key in QIYUN_STATE_DIR QIYUN_SECRET_DIR QIYUN_PROJECT_NAME QIYUN_CONTROL_IMAGE QIYUN_PORT QIYUN_AGENT_PORT QIYUN_AGENT_BIND QIYUN_AGENT_URL QIYUN_AGENT_HOSTNAMES QIYUN_ALLOWED_ORIGINS QIYUN_DEMO; do
      printenv "$key" | { IFS= read -r value; printf '%s=%s\n' "$key" "$value"; }
    done
  } > "$config.tmp"
  mv "$config.tmp" "$config"
fi
test ! -L "$QIYUN_SECRET_DIR" || fail 'Secret directory must not be a symlink.'
mkdir -p "$QIYUN_SECRET_DIR"
chmod 700 "$QIYUN_SECRET_DIR"
secret=$QIYUN_SECRET_DIR/ark.key
test ! -L "$secret" || fail 'Secret file must not be a symlink.'
secret_changed=0
tty_state=''
cleanup() { if test -n "$tty_state"; then stty "$tty_state" < /dev/tty; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if test ! -s "$secret"; then
  if test -n "${QIYUN_ARK_KEY_FILE:-}"; then
    test -f "$QIYUN_ARK_KEY_FILE" && test -r "$QIYUN_ARK_KEY_FILE" || fail 'Ark key file is not readable.'
    test "$(wc -c < "$QIYUN_ARK_KEY_FILE")" -le 16384 || fail 'Ark key file is too large.'
    cp "$QIYUN_ARK_KEY_FILE" "$secret.tmp"
    mv "$secret.tmp" "$secret"
    secret_changed=1
  elif test "${QIYUN_SKIP_ARK:-0}" != 1 && test "${QIYUN_NONINTERACTIVE:-0}" != 1 && (test -r /dev/tty && : < /dev/tty) 2>/dev/null; then
    printf '%s' 'Ark Coding Plan key (hidden; Enter skips): ' > /dev/tty
    tty_state=$(stty -g < /dev/tty)
    stty -echo < /dev/tty
    IFS= read -r ark_key < /dev/tty || ark_key=''
    stty "$tty_state" < /dev/tty
    tty_state=''
    printf '\n' > /dev/tty
    printf '%s' "$ark_key" > "$secret.tmp"
    unset ark_key
    mv "$secret.tmp" "$secret"
    secret_changed=1
  elif test ! -f "$secret"; then
    : > "$secret"
  fi
else
  printf '%s\n' 'Existing Ark credential retained.'
fi
if test "$existing" = 0 || test ! -f "$state_dir/image.ready" || ! docker image inspect "$QIYUN_CONTROL_IMAGE" >/dev/null 2>&1 || test "${QIYUN_UPDATE:-0}" = 1; then
  printf '%s\n' 'Building control plane from this checkout...'
  dc build control
  # An interrupted first build must not adopt an unrelated pre-existing tag.
  printf '%s\n' "$QIYUN_CONTROL_IMAGE" > "$state_dir/image.ready"
fi
# The bind exposes only this file. Parent directories stay private on the host.
docker run --rm --network none --pull never --user 0:0 --mount "type=bind,src=$QIYUN_SECRET_DIR,dst=/run/qiyun-secrets" --entrypoint node "$QIYUN_CONTROL_IMAGE" -e 'const fs=require("node:fs");const p="/run/qiyun-secrets/ark.key";const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)throw Error("Invalid secret file");fs.chownSync(p,1000,1000);fs.chmodSync(p,0o400);'
if test "$secret_changed" = 1 || test "${QIYUN_UPDATE:-0}" = 1; then
  dc up -d --no-build --force-recreate --wait --wait-timeout 120 control
else
  dc up -d --no-build --wait --wait-timeout 120 control
fi
setup=$(dc exec -T control node -e 'fetch("http://127.0.0.1:4310/api/session").then(r=>r.json()).then(s=>console.log(s.setupRequired?"required":"ready")).catch(()=>process.exit(1))')
case "$setup" in
  required)
    if test -n "${QIYUN_ADMIN_PASSWORD_FILE:-}"; then
      test -f "$QIYUN_ADMIN_PASSWORD_FILE" && test -r "$QIYUN_ADMIN_PASSWORD_FILE" || fail 'Administrator password file is not readable.'
      dc exec -T -e "QIYUN_ADMIN_NAME=${QIYUN_ADMIN_NAME:-管理员}" control node apps/control/dist/bootstrap.js < "$QIYUN_ADMIN_PASSWORD_FILE"
    elif test "${QIYUN_NONINTERACTIVE:-0}" = 1; then
      fail 'Set QIYUN_ADMIN_PASSWORD_FILE for first noninteractive initialization, then rerun. The control plane remains loopback only.'
    elif (test -r /dev/tty && : < /dev/tty) 2>/dev/null; then
      if test -n "${QIYUN_ADMIN_NAME:-}"; then
        dc exec -e "QIYUN_ADMIN_NAME=$QIYUN_ADMIN_NAME" control node apps/control/dist/bootstrap.js < /dev/tty > /dev/tty
      else
        dc exec control node apps/control/dist/bootstrap.js < /dev/tty > /dev/tty
      fi
    else
      fail 'No terminal available; supply QIYUN_ADMIN_PASSWORD_FILE and rerun.'
    fi;;
  ready) printf '%s\n' 'Existing administrator retained.';;
  *) fail 'Unexpected setup status; initialization was not attempted.';;
esac
printf '%s\n' "Control plane ready: http://127.0.0.1:$QIYUN_PORT" "Saved configuration: $config" 'Use SSH local forwarding for remote access. Agent enrollment and helper allowlists are separate; see docs/RUNNING.md.'

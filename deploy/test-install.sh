#!/usr/bin/env sh
# Offline installer tests: every Docker command is intercepted by this fixture.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d /tmp/qiyun-install-test.XXXXXX)
cleanup() { case "$fixture" in /tmp/qiyun-install-test.*) rm -rf -- "$fixture";; esac; }
trap cleanup EXIT
mkdir -p "$fixture/repo/deploy" "$fixture/bin" "$fixture/docker"
cp "$source_dir/deploy/install.sh" "$fixture/repo/deploy/install.sh"
cp "$source_dir/deploy/compose.yaml" "$fixture/repo/deploy/compose.yaml"
: > "$fixture/repo/pnpm-lock.yaml"
cat > "$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >> "$MOCK_ROOT/calls"
case "$1" in
  info) exit 0;;
  ps) test ! -f "$MOCK_ROOT/container" || printf 'fixture-container\n'; exit 0;;
  volume) exit 0;;
  inspect) cat "$MOCK_ROOT/container"; exit 0;;
  image) test -f "$MOCK_ROOT/image"; exit;;
  run) exit 0;;
  compose)
    shift
    case "$1" in version) exit 0;; up) printf '%s\n' --wait-timeout; exit 0;; esac
    test "$1" = --project-directory; shift 2
    test "$1" = --project-name; shift 2
    test "$1" = --env-file; test -f "$2"; shift 2
    test "$1" = -f; compose_file=$2; shift 2
    case "$1" in
      build) : > "$MOCK_ROOT/image";;
      up) printf '%s\n' "$compose_file" > "$MOCK_ROOT/container";;
      exec)
        case "$*" in
          *bootstrap.js) cat > "$MOCK_ROOT/admin-input"; : > "$MOCK_ROOT/admin";;
          *) if test -f "$MOCK_ROOT/admin"; then printf 'ready\n'; else printf 'required\n'; fi;;
        esac;;
      *) exit 91;;
    esac;;
  *) exit 92;;
esac
MOCK
chmod +x "$fixture/bin/docker"
PATH=$fixture/bin:$PATH
MOCK_ROOT=$fixture/docker
QIYUN_STATE_DIR=$fixture/state
QIYUN_PROJECT_NAME=qiyun-fixture
QIYUN_NONINTERACTIVE=1
QIYUN_PORT=19310
QIYUN_AGENT_PORT=19311
QIYUN_ADMIN_PASSWORD_FILE=$fixture/password
QIYUN_ARK_KEY_FILE=$fixture/key
export PATH MOCK_ROOT QIYUN_STATE_DIR QIYUN_PROJECT_NAME QIYUN_NONINTERACTIVE QIYUN_PORT QIYUN_AGENT_PORT QIYUN_ADMIN_PASSWORD_FILE QIYUN_ARK_KEY_FILE
printf '%s' 'fixture-admin-password-only' > "$QIYUN_ADMIN_PASSWORD_FILE"
printf '%s' 'fixture-secret-never-in-arguments' > "$QIYUN_ARK_KEY_FILE"
sh "$fixture/repo/deploy/install.sh" > "$fixture/output"
cmp "$QIYUN_ADMIN_PASSWORD_FILE" "$MOCK_ROOT/admin-input"
cmp "$QIYUN_ARK_KEY_FILE" "$QIYUN_STATE_DIR/secrets/ark.key"
! grep -q 'fixture-secret\|fixture-admin-password' "$MOCK_ROOT/calls" "$QIYUN_STATE_DIR/deployment.env" "$fixture/output"
test "$(grep -c 'build control$' "$MOCK_ROOT/calls")" = 1
cp "$QIYUN_STATE_DIR/deployment.env" "$fixture/first.env"
printf '%s' 'replacement-credential-must-not-apply' > "$QIYUN_ARK_KEY_FILE"
QIYUN_PORT=19320 sh "$fixture/repo/deploy/install.sh" >> "$fixture/output"
cmp "$fixture/first.env" "$QIYUN_STATE_DIR/deployment.env"
grep -q '^fixture-secret-never-in-arguments$' "$QIYUN_STATE_DIR/secrets/ark.key"
test "$(grep -c 'bootstrap.js' "$MOCK_ROOT/calls")" = 1
test "$(grep -c 'build control$' "$MOCK_ROOT/calls")" = 1
QIYUN_UPDATE=1 sh "$fixture/repo/deploy/install.sh" >> "$fixture/output"
test "$(grep -c 'build control$' "$MOCK_ROOT/calls")" = 2
printf '/some/other/checkout/deploy/compose.yaml\n' > "$MOCK_ROOT/container"
before=$(grep -c 'up -d' "$MOCK_ROOT/calls")
if sh "$fixture/repo/deploy/install.sh" > "$fixture/error" 2>&1; then echo 'Foreign deployment was accepted' >&2; exit 1; fi
grep -q 'another checkout' "$fixture/error"
test "$(grep -c 'up -d' "$MOCK_ROOT/calls")" = "$before"
rm "$MOCK_ROOT/container" "$MOCK_ROOT/admin" "$MOCK_ROOT/image"
QIYUN_STATE_DIR=$fixture/skip-state QIYUN_ARK_KEY_FILE='' QIYUN_SKIP_ARK=1 sh "$fixture/repo/deploy/install.sh" >> "$fixture/output"
test -f "$fixture/skip-state/secrets/ark.key"
test ! -s "$fixture/skip-state/secrets/ark.key"
printf '%s\n' 'Installer fixture passed: bootstrap, secret isolation, rerun, explicit rebuild, foreign project rejection, no-key setup.'

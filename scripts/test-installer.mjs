// Run in a disposable Linux container with bash, git, coreutils and Node installed.
// Git uses a local fixture; apt/curl/docker/install are mocks. No host daemon is used.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

if (process.platform !== 'linux' || process.env.QIYUN_INSTALLER_TEST_CONTAINER !== '1' || !existsSync('/.dockerenv')) {
  throw new Error('Run this suite only in a disposable Linux container with QIYUN_INSTALLER_TEST_CONTAINER=1.');
}
const source = readFileSync(resolve('install.sh'), 'utf8');
const base = mkdtempSync(join(tmpdir(), 'qiyun-installer-tests-'));
const fixture = join(base, 'upstream');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const realSed = execFileSync('sh', ['-c', 'command -v sed'], { encoding: 'utf8' }).trim();
const realInstall = execFileSync('sh', ['-c', 'command -v install'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync(realGit, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const executable = (path, body) => writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
const dockerMock = `if [[ "\${1:-}" == compose && "\${2:-}" == version && "\${QIYUN_TEST_NO_COMPOSE:-0}" == 1 ]]; then exit 1; fi\nprintf '%s\\n' "$*" >> "$QIYUN_TEST_DOCKER_LOG"\nexit 0`;
let passed = 0;

try {
  mkdirSync(join(fixture, 'deploy'), { recursive: true });
  writeFileSync(join(fixture, '.gitignore'), '.env\ndata/\ndeployed.fixture\n');
  writeFileSync(join(fixture, 'pnpm-lock.yaml'), 'fixture\n');
  writeFileSync(join(fixture, 'deploy/compose.yaml'), 'services: {}\n');
  executable(join(fixture, 'deploy/install.sh'), '[[ "${QIYUN_TEST_DEPLOY_FAIL:-0}" != 1 ]] || exit 23\nprintf deployed > "$QIYUN_INSTALL_DIR/deployed.fixture"');
  git('init', '--quiet', fixture);
  git('-C', fixture, 'add', '.');
  git('-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture v1');
  git('-C', fixture, 'tag', 'v0.1.0');
  const firstCommit = git('-C', fixture, 'rev-parse', 'HEAD');
  writeFileSync(join(fixture, 'next-version'), 'v2\n');
  git('-C', fixture, 'add', '.');
  git('-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture v2');
  git('-C', fixture, 'tag', 'v0.2.0');

  function setup(name, { docker = true } = {}) {
    const directory = join(base, name);
    const bin = join(directory, 'bin');
    mkdirSync(bin, { recursive: true });
    const installDir = join(directory, 'qiyun');
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, QIYUN_REPO: 'fixture/qiyun',
      QIYUN_REF: 'v0.1.0', QIYUN_INSTALL_DIR: installDir, QIYUN_INSTALL_DEPS: '0',
      QIYUN_COMMIT: '', QIYUN_TEST_REMOTE: fixture, QIYUN_TEST_REAL_GIT: realGit,
      QIYUN_TEST_REAL_SED: realSed, QIYUN_TEST_REAL_INSTALL: realInstall,
      QIYUN_TEST_BIN: bin, QIYUN_TEST_DOCKER_LOG: join(directory, 'docker.log'),
      QIYUN_TEST_APT_LOG: join(directory, 'apt.log'), QIYUN_TEST_CAPTURE: join(directory, 'capture'),
      QIYUN_TEST_DOCKER_TEMPLATE: join(directory, 'docker-template'),
      QIYUN_TEST_GIT_TEMPLATE: join(directory, 'git-template'),
    };
    executable(join(bin, 'git'), `args=("$@")\nfetch=0\nfor ((i=0;i<\${#args[@]};i++)); do\n  [[ "\${args[i]}" != fetch ]] || fetch=1\n  if [[ "$fetch" == 1 && "\${args[i]}" == origin ]]; then\n    [[ "\${QIYUN_TEST_FETCH_FAIL:-0}" != 1 ]] || exit 17\n    args[i]="$QIYUN_TEST_REMOTE"\n  fi\ndone\nexec "$QIYUN_TEST_REAL_GIT" "\${args[@]}"`);
    writeFileSync(env.QIYUN_TEST_GIT_TEMPLATE, readFileSync(join(bin, 'git')), { mode: 0o755 });
    executable(env.QIYUN_TEST_DOCKER_TEMPLATE, dockerMock);
    if (docker) executable(join(bin, 'docker'), dockerMock);
    executable(join(bin, 'sed'), `if [[ "\${QIYUN_TEST_APT_OS:-0}" == 1 && "\${*: -1}" == /etc/os-release ]]; then\n case "$*" in *VERSION_CODENAME*) echo noble ;; *VERSION_ID*) echo 24.04 ;; *) echo ubuntu ;; esac\nelse exec "$QIYUN_TEST_REAL_SED" "$@"; fi`);
    executable(join(bin, 'dpkg-query'), `[[ "\${QIYUN_TEST_DPKG_ERROR:-0}" != 1 ]] || exit 2\nif [[ "\${QIYUN_TEST_CONFLICT:-0}" == 1 && "\${*: -1}" == runc ]]; then printf installed; else exit 1; fi`);
    executable(join(bin, 'apt-get'), `[[ "\${DEBIAN_FRONTEND:-}" == noninteractive && "\${NEEDRESTART_MODE:-}" == l ]] || exit 91\nif IFS= read -r unexpected; then echo 'apt consumed installer stdin' >&2; exit 92; fi\nprintf '%s\\n' "$*" >> "$QIYUN_TEST_APT_LOG"\nif [[ " $* " == *" git "* ]]; then cp "$QIYUN_TEST_GIT_TEMPLATE" "$QIYUN_TEST_BIN/git"; fi\nif [[ "$*" == *docker-ce* ]]; then cp "$QIYUN_TEST_DOCKER_TEMPLATE" "$QIYUN_TEST_BIN/docker"; fi`);
    executable(join(bin, 'curl'), `[[ "$*" == *https://download.docker.com/linux/ubuntu/gpg* ]] || exit 88\nwhile (( $# )); do if [[ "$1" == -o ]]; then printf fixture-public-key > "$2"; exit 0; fi; shift; done\nexit 89`);
    executable(join(bin, 'install'), `last="\${*: -1}"\nif [[ "$last" == /etc/apt/* ]]; then\n mkdir -p "$QIYUN_TEST_CAPTURE"\n if [[ "$1" != -d ]]; then cp "\${@: -2:1}" "$QIYUN_TEST_CAPTURE/$(basename "$last")"; fi\nelse exec "$QIYUN_TEST_REAL_INSTALL" "$@"; fi`);
    const run = (extra = {}) => spawnSync('bash', [], { input: source, encoding: 'utf8', env: { ...env, ...extra }, timeout: 20000 });
    return { directory, installDir, env, run };
  }
  function check(name, body) { body(); passed++; console.log(`PASS ${name}`); }
  function succeeds(result) { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /deployment completed successfully/); }
  function fails(result, pattern) { assert.notEqual(result.status, 0); assert.match(result.stderr, pattern); assert.doesNotMatch(result.stdout, /deployment completed successfully/); }
  function noStages(test) { assert.equal(readdirSync(test.directory).some(name => name.startsWith('.qiyun-stage.')), false); }

  check('tag installation, detached SHA and safe rerun retain ignored configuration/data', () => {
    const t = setup('tag'); succeeds(t.run());
    assert.equal(git('-C', t.installDir, 'rev-parse', 'HEAD'), firstCommit);
    assert.equal(git('-C', t.installDir, 'config', '--get', 'remote.origin.url'), 'https://github.com/fixture/qiyun.git');
    writeFileSync(join(t.installDir, '.env'), 'KEEP_EXISTING_CONFIGURATION=1\n');
    mkdirSync(join(t.installDir, 'data')); writeFileSync(join(t.installDir, 'data/keep'), 'persistent');
    succeeds(t.run()); assert.equal(readFileSync(join(t.installDir, 'data/keep'), 'utf8'), 'persistent');
    assert.match(readFileSync(join(t.installDir, '.env'), 'utf8'), /KEEP_EXISTING/); noStages(t);
  });
  check('full commit installation', () => { const t = setup('sha'); succeeds(t.run({ QIYUN_REF: firstCommit })); });
  check('floating ref and invalid repository rejected before creating target', () => {
    const t = setup('floating'); fails(t.run({ QIYUN_REF: 'main' }), /floating branches/);
    fails(t.run({ QIYUN_REPO: 'https://attacker.invalid/repo' }), /owner\/repository/); assert.equal(existsSync(t.installDir), false);
  });
  check('unrelated directory is preserved', () => {
    const t = setup('unrelated'); mkdirSync(t.installDir); writeFileSync(join(t.installDir, 'keep'), 'safe');
    fails(t.run(), /not a standalone Git checkout/); assert.equal(readFileSync(join(t.installDir, 'keep'), 'utf8'), 'safe');
  });
  check('symlink install target rejected', () => { const t = setup('symlink'); symlinkSync(fixture, t.installDir); fails(t.run(), /symbolic link/); });
  check('dirty tracked source is retained', () => {
    const t = setup('dirty'); succeeds(t.run()); writeFileSync(join(t.installDir, 'pnpm-lock.yaml'), 'local change');
    fails(t.run(), /local changes/); assert.equal(readFileSync(join(t.installDir, 'pnpm-lock.yaml'), 'utf8'), 'local change');
  });
  check('assume-unchanged cannot hide a modified tracked file', () => {
    const t = setup('hidden-dirty'); succeeds(t.run());
    git('-C', t.installDir, 'update-index', '--assume-unchanged', 'pnpm-lock.yaml');
    writeFileSync(join(t.installDir, 'pnpm-lock.yaml'), 'hidden local change');
    fails(t.run(), /Assume-unchanged/); assert.equal(readFileSync(join(t.installDir, 'pnpm-lock.yaml'), 'utf8'), 'hidden local change');
  });
  check('untracked file is retained', () => {
    const t = setup('untracked'); succeeds(t.run()); writeFileSync(join(t.installDir, 'custom.txt'), 'user file');
    fails(t.run(), /untracked files/); assert.equal(readFileSync(join(t.installDir, 'custom.txt'), 'utf8'), 'user file');
  });
  check('origin mismatch is rejected', () => {
    const t = setup('origin'); succeeds(t.run()); git('-C', t.installDir, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    fails(t.run(), /origin does not exactly match/);
  });
  check('automatic version replacement is rejected', () => {
    const t = setup('upgrade'); succeeds(t.run()); fails(t.run({ QIYUN_REF: 'v0.2.0' }), /different version/);
    assert.equal(git('-C', t.installDir, 'rev-parse', 'HEAD'), firstCommit); noStages(t);
  });
  check('tag commit mismatch and fetch failure leave no target or staging', () => {
    const t = setup('fetch'); fails(t.run({ QIYUN_COMMIT: '1'.repeat(40) }), /does not resolve/);
    assert.equal(existsSync(t.installDir), false); noStages(t);
    fails(t.run({ QIYUN_TEST_FETCH_FAIL: '1' }), /installation failed/); assert.equal(existsSync(t.installDir), false); noStages(t);
  });
  check('deployment failure is never reported as success', () => {
    const t = setup('deploy-failure'); fails(t.run({ QIYUN_TEST_DEPLOY_FAIL: '1' }), /installation failed/);
    assert.equal(git('-C', t.installDir, 'rev-parse', 'HEAD'), firstCommit); noStages(t);
  });
  check('disabled dependencies fail without apt changes', () => {
    const t = setup('deps-disabled', { docker: false }); fails(t.run(), /dependency installation was disabled/);
    assert.equal(existsSync(t.env.QIYUN_TEST_APT_LOG), false);
  });
  check('existing Docker without Compose is not replaced', () => {
    const t = setup('compose'); fails(t.run({ QIYUN_TEST_NO_COMPOSE: '1', QIYUN_INSTALL_DEPS: '1' }), /will not upgrade or replace/);
    assert.equal(existsSync(t.env.QIYUN_TEST_APT_LOG), false);
  });
  check('existing Docker with missing Git installs only prerequisites without consuming pipe input', () => {
    const t = setup('git-only');
    rmSync(join(t.env.QIYUN_TEST_BIN, 'git'));
    for (const command of ['bash', 'sh', 'uname', 'realpath', 'dirname', 'mkdir', 'tr', 'grep', 'rm', 'mktemp', 'mv', 'cp', 'cmp', 'basename']) {
      const actual = execFileSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
      symlinkSync(actual, join(t.env.QIYUN_TEST_BIN, command));
    }
    succeeds(t.run({ PATH: t.env.QIYUN_TEST_BIN, QIYUN_INSTALL_DEPS: '1', QIYUN_TEST_APT_OS: '1' }));
    const calls = readFileSync(t.env.QIYUN_TEST_APT_LOG, 'utf8');
    assert.match(calls, /--force-confold/); assert.match(calls, /git ca-certificates curl/); assert.doesNotMatch(calls, /docker-ce/);
  });
  check('existing container infrastructure blocks automatic Docker installation', () => {
    const t = setup('conflict', { docker: false }); fails(t.run({ QIYUN_INSTALL_DEPS: '1', QIYUN_TEST_APT_OS: '1', QIYUN_TEST_CONFLICT: '1' }), /Existing package runc/);
    assert.equal(existsSync(t.env.QIYUN_TEST_APT_LOG), false);
  });
  check('package database errors fail closed before apt changes', () => {
    const t = setup('dpkg-error', { docker: false });
    fails(t.run({ QIYUN_INSTALL_DEPS: '1', QIYUN_TEST_APT_OS: '1', QIYUN_TEST_DPKG_ERROR: '1' }), /package database could not be inspected/);
    assert.equal(existsSync(t.env.QIYUN_TEST_APT_LOG), false);
  });
  check('missing Docker follows official apt repository with no real package installation', () => {
    const t = setup('docker-install', { docker: false }); succeeds(t.run({ QIYUN_INSTALL_DEPS: '1', QIYUN_TEST_APT_OS: '1' }));
    const calls = readFileSync(t.env.QIYUN_TEST_APT_LOG, 'utf8'); assert.match(calls, /--no-upgrade --no-remove docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin/);
    const repo = readFileSync(join(t.env.QIYUN_TEST_CAPTURE, 'qiyun-docker.sources'), 'utf8');
    assert.match(repo, /https:\/\/download.docker.com\/linux\/ubuntu/); assert.match(repo, /Signed-By: \/etc\/apt\/keyrings\/qiyun-docker.asc/);
  });
  console.log(`${passed} installer checks passed; no real package manager or Docker daemon was invoked.`);
} finally {
  // Only the directory created by this test run is removed.
  rmSync(base, { recursive: true, force: true });
}

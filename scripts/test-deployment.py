"""Real public-source installation in an isolated Linux/Docker fixture; no model calls."""
import http.cookiejar
import json
import os
import pty
from pathlib import Path
import select
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

ref = sys.argv[1]
assert len(ref) == 40 and all(c in '0123456789abcdef' for c in ref)
assert os.geteuid() == 0
assert os.environ.get('QIYUN_TEST_PUBLIC_INSTALL') == '1', 'Explicit fixture opt-in required'
run_id = 'qiyun-fixture-' + uuid.uuid4().hex[:10]
root = Path('/opt') / run_id
assert root.parent == Path('/opt') and root.name.startswith('qiyun-fixture-') and not root.exists()
root.mkdir(mode=0o700)
checkout = root / 'source'
state = root / 'state'
workspace = Path(__file__).resolve().parents[1]
logs = workspace / '.local' / run_id
logs.mkdir(parents=True)
def run(args, **kw):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kw).stdout.strip()
def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]
port, agent_port = free_port(), free_port()
assert port != agent_port
password = 'fixture-admin-' + uuid.uuid4().hex
key = 'fixture-not-a-real-key-' + uuid.uuid4().hex
password_file, key_file = root / 'password', root / 'key'
for path, value in [(password_file, password), (key_file, key)]:
    path.write_text(value + '\n')
    path.chmod(0o600)
env = dict(os.environ, BUILDKIT_PROGRESS='plain', QIYUN_REF=ref, QIYUN_INSTALL_DIR=str(checkout),
           QIYUN_INSTALL_DEPS='0', QIYUN_STATE_DIR=str(state), QIYUN_PROJECT_NAME=run_id,
           QIYUN_PORT=str(port), QIYUN_AGENT_PORT=str(agent_port), QIYUN_NONINTERACTIVE='1',
           QIYUN_ADMIN_NAME='Deployment fixture', QIYUN_ADMIN_PASSWORD_FILE=str(password_file),
           QIYUN_ARK_KEY_FILE=str(key_file))
compose = ['docker', 'compose', '--project-directory', str(checkout / 'deploy'),
           '--project-name', run_id, '--env-file', str(state / 'deployment.env'),
           '-f', str(checkout / 'deploy/compose.yaml')]
evidence = {'source': ref, 'fixture': run_id, 'checks': []}
def check(condition, description):
    assert condition, description
    evidence['checks'].append(description)
    print('PASS ' + description, flush=True)
def install(number):
    with (logs / f'install-{number}.log').open('w') as log:
        result = subprocess.run(['bash', str(root / 'install.sh')], env=env, stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, text=True, timeout=900)
    if result.returncode:
        print((logs / f'install-{number}.log').read_text()[-6000:], flush=True)
    check(result.returncode == 0, f'public installer run {number} exited successfully')
def install_interactively():
    interactive_env = dict(env)
    for name in ['QIYUN_NONINTERACTIVE', 'QIYUN_ADMIN_NAME', 'QIYUN_ADMIN_PASSWORD_FILE', 'QIYUN_ARK_KEY_FILE']:
        interactive_env.pop(name, None)
    pid, fd = pty.fork()
    if pid == 0:
        os.execve('/bin/bash', ['bash', '-o', 'pipefail', '-c', 'curl -fsSL "$1" | bash',
                  'qiyun-install-fixture', f'https://raw.githubusercontent.com/Hello1999/qiyun/{ref}/install.sh'], interactive_env)
    prompts = [('Ark Coding Plan key', key), ('管理员名称:', 'Deployment fixture'), ('管理员密码', password)]
    output = ''
    index = 0
    start = time.monotonic()
    try:
        while True:
            if time.monotonic() - start > 900:
                os.kill(pid, 15)
                raise TimeoutError('Interactive installation exceeded its test budget')
            ready, _, _ = select.select([fd], [], [], 1)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk.decode('utf-8', errors='replace')
                if index < len(prompts) and prompts[index][0] in output:
                    # Let the prompt finish switching the terminal to hidden input.
                    time.sleep(0.1)
                    os.write(fd, (prompts[index][1] + '\n').encode())
                    index += 1
        _, status = os.waitpid(pid, 0)
        (logs / 'install-1-interactive.log').write_text(output)
        if os.waitstatus_to_exitcode(status):
            print(output[-6000:], flush=True)
        check(os.waitstatus_to_exitcode(status) == 0, 'interactive public installer exited successfully')
        check(index == 3, 'terminal prompts for key, administrator name, and password')
        check(password not in output and key not in output, 'interactive secret input is hidden')
    finally:
        os.close(fd)
def request(path, body=None, opener=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{port}'})
    with (opener.open(req, timeout=20) if opener else urllib.request.urlopen(req, timeout=20)) as response:
        return json.load(response)
def login_and_inspect():
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    session = request('/api/auth/login', {'password': password}, opener)
    check(session.get('authenticated') is True and session.get('name') == 'Deployment fixture', 'original administrator authenticates')
    overview = request('/api/overview', opener=opener)
    check(overview['provider']['configured'] is True, 'server reads the mounted model key')
    check(overview['provider']['model'] == 'deepseek-v4.1-flash', 'specified model is retained')
    check(key not in json.dumps(overview), 'model key is absent from the browser response')
try:
    run(['curl', '-fLsS', '--retry', '2', '--max-time', '120',
         f'https://raw.githubusercontent.com/Hello1999/qiyun/{ref}/install.sh', '-o', str(root / 'install.sh')])
    if len(sys.argv) > 2 and sys.argv[2] == 'interactive':
        install_interactively()
    else:
        install(1)
    check(run(['git', '-C', str(checkout), 'rev-parse', 'HEAD']) == ref, 'checkout matches the public commit')
    check(request('/api/session')['setupRequired'] is False, 'administrator initialization completed')
    login_and_inspect()
    cid = run(compose + ['ps', '-q', 'control'])
    details = json.loads(run(['docker', 'inspect', cid]))[0]
    check(details['State']['Health']['Status'] == 'healthy', 'container health check passed')
    bindings = details['HostConfig']['PortBindings']
    check(all(v['HostIp'] == '127.0.0.1' for b in bindings.values() for v in b), 'both published ports bind only to loopback')
    check(key not in json.dumps(details), 'model key is absent from Docker inspection')
    config_before = (state / 'deployment.env').read_bytes()
    stored_key = state / 'secrets/ark.key'
    check(stored_key.read_text().strip() == key, 'private model key was copied correctly')
    check(stored_key.stat().st_uid == 1000 and stat.S_IMODE(stored_key.stat().st_mode) == 0o400, 'model key has UID 1000 and mode 0400')
    check(key.encode() not in config_before, 'deployment configuration contains no model key')
    volume_before = [v['Name'] for v in details['Mounts'] if v['Type'] == 'volume']
    (checkout / '.env').write_text('QIYUN_PORT=1\nARK_API_KEY=ambient-must-not-load\n')
    password_file.write_text('different-password-do-not-apply\n')
    key_file.write_text('different-key-do-not-apply\n')
    install(2)
    check((state / 'deployment.env').read_bytes() == config_before, 'repeat run preserves deployment configuration')
    check(stored_key.read_text().strip() == key, 'repeat run preserves the original model key')
    login_and_inspect()
    cid_after = run(compose + ['ps', '-q', 'control'])
    details_after = json.loads(run(['docker', 'inspect', cid_after]))[0]
    check([v['Name'] for v in details_after['Mounts'] if v['Type'] == 'volume'] == volume_before, 'repeat run preserves the data volume')
    check(cid_after == cid, 'repeat run preserves the healthy running container')
    evidence['passed'] = True
finally:
    if (state / 'deployment.env').exists() and (checkout / 'deploy/compose.yaml').exists():
        cleanup = subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], capture_output=True, text=True)
        (logs / 'cleanup.log').write_text(cleanup.stdout + cleanup.stderr)
        evidence['cleanup_exit'] = cleanup.returncode
        image_cleanup = subprocess.run(['docker', 'image', 'rm', run_id + '-control:local'], capture_output=True, text=True)
        evidence['image_cleanup_exit'] = image_cleanup.returncode
    (logs / 'result.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    assert root.resolve().parent == Path('/opt') and root.name.startswith('qiyun-fixture-')
    shutil.rmtree(root)
    print('Evidence: ' + str(logs), flush=True)

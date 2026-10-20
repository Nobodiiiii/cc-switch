"""Verify a Rust-generated Route Matrix catalog using real Codex model/list.

Only a temporary CODEX_HOME and an authenticated loopback HTTP server are used.
No real account, inference request, client configuration or credentials are read.
"""
import argparse
import http.server
import json
import os
import pathlib
import queue
import subprocess
import threading
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--codex', required=True)
parser.add_argument('--catalog', required=True)
parser.add_argument('--config', required=True)
parser.add_argument('--work-dir', required=True)
args = parser.parse_args()
payload = pathlib.Path(args.catalog).read_bytes()
assert len(payload) <= 1024 * 1024, 'Catalog exceeds the Codex JSON response limit'
catalog = json.loads(payload)
expected = {
    row['slug'] for row in catalog['models']
    if row.get('visibility') == 'list' and row.get('supported_in_api', True)
}
assert any(model.startswith('rm-backup/') for model in expected)
assert any(not model.startswith('rm-') for model in expected)
requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        authorized = self.headers.get('Authorization') == 'Bearer probe-local-token'
        requests.append({'path': self.path, 'authorized': authorized})
        if not authorized or self.path.split('?')[0] != '/route-matrix/v1/models':
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
work = pathlib.Path(args.work_dir).resolve()
home = work / str(uuid.uuid4())
home.mkdir(parents=True)
config = pathlib.Path(args.config).read_text(encoding='utf-8')
config = config.replace('http://127.0.0.1:19000', f'http://127.0.0.1:{server.server_port}')
config = 'cli_auth_credentials_store = "file"\n' + config
(home / 'config.toml').write_text(config, encoding='utf-8')
env = dict(os.environ, CODEX_HOME=str(home))
for name in ['OPENAI_API_KEY', 'CODEX_API_KEY']:
    env.pop(name, None)
stderr = (home / 'stderr.log').open('w', encoding='utf-8')
process = subprocess.Popen(
    [args.codex, 'app-server', '--listen', 'stdio://'], cwd=home, env=env,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
    text=True, encoding='utf-8',
    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
)
messages = queue.Queue()


def read():
    for line in process.stdout:
        try:
            messages.put(json.loads(line))
        except ValueError:
            pass


threading.Thread(target=read, daemon=True).start()


def send(value):
    process.stdin.write(json.dumps(value) + '\n')
    process.stdin.flush()


def receive(identifier):
    limit = time.monotonic() + 30
    while time.monotonic() < limit:
        value = messages.get(timeout=max(0.1, limit - time.monotonic()))
        if value.get('id') == identifier:
            assert not value.get('error'), value
            return value['result']
    raise TimeoutError('Codex RPC timed out')


try:
    send({'id': 1, 'method': 'initialize', 'params': {
        'clientInfo': {'name': 'cc_switch_route_matrix_probe', 'version': '1'},
        'capabilities': {'experimentalApi': True},
    }})
    receive(1)
    send({'method': 'initialized'})
    send({'id': 2, 'method': 'model/list', 'params': {'limit': 100, 'includeHidden': False}})
    result = receive(2)
    actual = {model['id'] for model in result['data']}
    assert actual == expected, f'Model list differs: missing={expected - actual}, extra={actual - expected}'
    assert requests and all(request['authorized'] for request in requests), requests
    print(f'Real Codex model/list passed: {len(actual)} visible models, {len(payload)} catalog bytes')
finally:
    if process.poll() is None:
        process.terminate()
    process.wait(timeout=10)
    stderr.close()
    server.shutdown()
    logs = (home / 'stderr.log').read_text(encoding='utf-8')
    if logs.strip():
        print(logs)

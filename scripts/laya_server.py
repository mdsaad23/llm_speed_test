#!/usr/bin/env python3
"""Local HTTP wrapper around Laya (https://huggingface.co/convaiinnovations/laya).

Laya's own predict() already speaks the same {state, questions} -> {answers, usage} shape
providers.ts's layaAdapter expects (it mirrors jevAdapter's experimental_evaluate call) — this
just puts it behind localhost so the TS side can `fetch` it like it does Ollama.

Setup — installed globally into Python 3.12 (its dependencies' wheels are confirmed there;
newer Pythons on this machine are untested and providers.ts never assumes plain `python`/`py`
resolves to one that has laya on it):
    py -3.12 -m pip install laya

That alone is enough: selecting `laya` in the app spawns this file itself (see
layaCommand/ensureLayaRunning in lib/decide/providers.ts) via `py -3.12`. Only run it by hand
to see setup errors directly, or to pin a specific checkpoint with --subfolder.

Prefer a project-local install instead? `py -3.12 -m venv .venv && .venv\\Scripts\\pip install laya`
— the venv is picked up automatically ahead of the global one.
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import laya


def make_handler(agent):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass  # quiet by default; errors below still print

        def do_GET(self):
            if self.path != '/health':
                self.send_response(404)
                self.end_headers()
                return
            self._reply(200, {'status': 'ok'})

        def do_POST(self):
            if self.path != '/predict':
                self.send_response(404)
                self.end_headers()
                return
            length = int(self.headers['Content-Length'])
            req = json.loads(self.rfile.read(length))
            try:
                result = agent.predict(req['state'], req['questions'])
                self._reply(200, result)
            except Exception as e:
                print(f'[laya_server] {e}')
                self._reply(500, {'error': str(e)})

        def _reply(self, status, obj):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, default=8420)
    # ponytail: no ROCm/DirectML path on this machine (checked) — CPU only until that changes.
    p.add_argument('--subfolder', default=None, help='e.g. multilingual, typed-decisions')
    args = p.parse_args()

    print(f'loading laya (subfolder={args.subfolder or "english root"}, device=cpu)...')
    agent = laya.load('convaiinnovations/laya', device='cpu', subfolder=args.subfolder)
    print(f'ready on http://localhost:{args.port}/predict')

    ThreadingHTTPServer(('localhost', args.port), make_handler(agent)).serve_forever()


if __name__ == '__main__':
    main()

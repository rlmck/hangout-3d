"""Serve the viewer and rebuild the model when hangout_layout.json changes.

    python serve.py [port]        (default port 8000)

Watches hangout_layout.json -> runs build_model.py -> tells open viewers to hot-reload the model.
Tells viewers to redraw holds when problems.json changes. Also full-reloads the page when index.html / viewer.js change. Stdlib only (the build needs trimesh + numpy).
"""
import http.server, json, os, subprocess, sys, threading, time, webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
LAYOUT, GLB = os.path.join(ROOT, 'hangout_layout.json'), os.path.join(ROOT, 'hangout_blockout.glb')
PROBLEMS = os.path.join(ROOT, 'problems.json')
PAGE_FILES = [os.path.join(ROOT, f) for f in ('index.html', 'viewer.js')]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

cond = threading.Condition()
event = {'seq': 0, 'data': None}  # latest event broadcast to all SSE clients


def broadcast(kind, **payload):
    with cond:
        event['seq'] += 1
        event['data'] = json.dumps({'type': kind, **payload})
        cond.notify_all()


def mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0


def build():
    print(time.strftime('[%H:%M:%S]'), 'building model...', flush=True)
    broadcast('building')
    r = subprocess.run([sys.executable, 'build_model.py'], cwd=ROOT, capture_output=True, text=True)
    if r.returncode == 0:
        print('   ', r.stdout.strip(), flush=True)
        broadcast('model')
    else:
        err = (r.stderr or r.stdout).strip()
        print(err, flush=True)
        broadcast('error', message=err.splitlines()[-1] if err else 'build failed')


def watch():
    last_layout = mtime(LAYOUT)
    last_page = [mtime(p) for p in PAGE_FILES]
    last_problems = mtime(PROBLEMS)
    while True:
        time.sleep(0.4)
        m = mtime(LAYOUT)
        if m != last_layout:
            time.sleep(0.3)  # let the editor finish writing
            last_layout = mtime(LAYOUT)
            build()
        m = mtime(PROBLEMS)
        if m != last_problems:
            time.sleep(0.3)
            last_problems = mtime(PROBLEMS)
            broadcast('problems')  # drawn by the viewer, no rebuild needed
        page = [mtime(p) for p in PAGE_FILES]
        if page != last_page:
            last_page = page
            broadcast('page')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console for build output

    def do_GET(self):
        if self.path != '/events':
            return super().do_GET()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        with cond:
            seen = event['seq']
        try:
            while True:
                with cond:
                    cond.wait_for(lambda: event['seq'] != seen, timeout=15)
                    seq, data = event['seq'], event['data']
                if seq == seen:
                    self.wfile.write(b': ping\n\n')
                else:
                    seen = seq
                    self.wfile.write(f'data: {data}\n\n'.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


if __name__ == '__main__':
    if mtime(GLB) < mtime(LAYOUT):
        build()
    threading.Thread(target=watch, daemon=True).start()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    url = f'http://127.0.0.1:{PORT}/'
    print(f'Viewer at {url}  (edit hangout_layout.json to rebuild; Ctrl+C to stop)', flush=True)
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

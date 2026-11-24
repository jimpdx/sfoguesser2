"""Local dev server with browser caching turned off.

Python's plain http.server lets browsers cache files, so after an edit a
page can come back with the new index.html but an old app.js. This one
sends Cache-Control: no-store so a normal reload always picks up changes.

Usage: python -I tools/serve.py [port]   (default 8000)
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {ROOT} at http://127.0.0.1:{port}/ (no caching)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()

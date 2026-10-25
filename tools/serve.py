"""开发用静态服务器：禁用缓存，避免 WebView2 拿到 304 后显示空白。

用法：python tools/serve.py [port] [dir]
"""

import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 1420
    directory = sys.argv[2] if len(sys.argv) > 2 else "web"
    handler = functools.partial(Handler, directory=directory)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {directory} on http://127.0.0.1:{port} (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()

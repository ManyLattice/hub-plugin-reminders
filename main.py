"""Процесс плагина «Напоминания»: отдаёт странице карточки владельцу, которые остались без ответа дольше суток. Ядро держит их
в состоянии (sess["asks"]), но в снимок страницы они не попадают. Читает состояние ядра, ничего не пишет и не правит.

Страница и процесс говорят по 127.0.0.1:<порт страницы + 14>; принимаются только запросы со страницы хаба (Origin)."""
import http.server
import json
import os
import threading
import time

from core import journal

import asks

STATE = os.environ.get("HUB_STATE_DIR", "")
WEB_PORT = int(os.environ.get("HUB_WEB_PORT", "8787"))
PORT = WEB_PORT + 14
CACHE = 5   # с: состояние ядра читается не чаще (страница спрашивает раз в полминуты)


class Plugin:
    def __init__(self, state_dir, load=journal.load_state, clock=time.time):
        self.dir, self.load, self.clock = state_dir, load, clock
        self.lock, self.cached = threading.Lock(), (0, [])

    def asks(self):
        with self.lock:
            now = self.clock()
            if now - self.cached[0] >= CACHE:
                self.cached = (now, asks.stale(self.load(self.dir), now))
            return self.cached[1]

    def act(self, path, origin):
        """Запрос страницы -> (код, ответ). Только со страницы хаба этой машины."""
        if origin not in (f"http://127.0.0.1:{WEB_PORT}", f"http://localhost:{WEB_PORT}"):
            return 403, {"error": "только со страницы хаба"}
        if path == "/asks":
            try:
                return 200, {"asks": self.asks(), "ts": self.clock()}
            except (OSError, ValueError) as e:
                return 503, {"error": f"состояние хаба не прочиталось: {e}"}
        return 404, {"error": "нет такого"}


def serve(plugin):
    class Handler(http.server.BaseHTTPRequestHandler):
        def answer(self):
            origin = self.headers.get("Origin") or ""
            code, body = plugin.act(self.path.split("?")[0], origin)
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            if code != 403:
                self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = answer

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    serve(Plugin(STATE))
    print(f"напоминания: страница - 127.0.0.1:{PORT}", flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()

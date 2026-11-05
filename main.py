"""Процесс плагина «Напоминания»: карточки владельцу, которые остались без ответа дольше суток. Ядро держит их в состоянии
(sess["asks"]), но в снимок страницы они не попадают.

Процесс держит состояние ядра в памяти: целиком читает его один раз (и после ротации журнала), дальше раз в минуту
дочитывает только новые строки журнала. Список устаревших карточек он пишет постом в канал плагина, и только когда список
изменился: страница берёт его через саму страницу хаба (snap.feeds, hub.feed), поэтому блок работает и с телефона, и через
прокси. Своего порта у процесса нет."""
import json
import os
import time

from core import journal, reducer, spool

import asks

STATE = os.environ.get("HUB_STATE_DIR", "")
NAME = os.environ.get("HUB_EXTENSION", "reminders")
CHANNEL = NAME.split(":")[-1]
EVERY = 60          # с: опрос журнала; от числа открытых вкладок не зависит
POST_MAX = 19000    # знаков в посте канала (ядро принимает до 20 000)
KIND = "stale"


class Reader:
    """Состояние ядра без повторного чтения всего журнала: load_state при первом опросе, после ротации (другой файл) или
    усечения журнала; дальше - только строки, дописанные после прошлого раза."""

    def __init__(self, state_dir, load=journal.load_state):
        self.dir, self.load = state_dir, load
        self.path = os.path.join(state_dir, "journal.jsonl")
        self.state, self.ino, self.offset = None, None, 0
        self.loads = 0

    def _reload(self, st):
        # Размер берётся до чтения: load_state может прочитать и то, что дописали после stat, - повтор отсекает seq.
        self.state, self.ino, self.offset = self.load(self.dir), st.st_ino, st.st_size
        self.loads += 1

    def poll(self):
        st = os.stat(self.path)
        if self.state is None or st.st_ino != self.ino or st.st_size < self.offset:
            self._reload(st)
            return self.state
        if st.st_size == self.offset:
            return self.state
        with open(self.path, "rb") as f:
            if os.fstat(f.fileno()).st_ino != self.ino:
                self._reload(st)
                return self.state
            f.seek(self.offset)
            chunk = f.read()
        end = chunk.rfind(b"\n")
        if end < 0:   # строка ещё дописывается
            return self.state
        events = [json.loads(x) for x in chunk[:end].split(b"\n") if x.strip()]
        events = [e for e in events if e.get("seq", 0) > self.state.get("seq", 0)]
        if events and events[0]["seq"] != self.state.get("seq", 0) + 1:   # дыра: журнал переписан не ротацией
            self._reload(st)
            return self.state
        self.offset += end + 1
        if events:
            self.state = reducer.fold(self.state, events)
        return self.state


def last_post(state):
    """Список из последнего поста процесса в канале (после перезапуска не повторяем тот же), или None."""
    for p in reversed((state.get("feeds") or {}).get(CHANNEL) or []):
        if p.get("by") in (f"плагин {NAME}", f"plugin {NAME}"):
            try:
                d = json.loads(p.get("text") or "")
            except ValueError:
                continue
            if isinstance(d, dict) and d.get("kind") == KIND and isinstance(d.get("asks"), list):
                return d["asks"]
    return None


def body(rows):
    """Текст поста: список целиком, а если не влезает в пост - старые первыми, сколько влезет."""
    rows = list(rows)
    while True:
        text = json.dumps({"kind": KIND, "asks": rows}, ensure_ascii=False, separators=(",", ":"))
        if len(text) <= POST_MAX or not rows:
            return text
        rows = rows[:-1]


class Plugin:
    def __init__(self, state_dir, reader=None, put=None, clock=time.time):
        self.reader = reader or Reader(state_dir)
        self.put = put or (lambda data: spool.put(os.path.join(state_dir, "spool"), "ext.post", None, data, src=f"ext:{NAME}"))
        self.clock = clock
        self.posted = None   # что уже в канале: None - ещё не знаем (смотрим в состоянии)

    def tick(self):
        """Один опрос: дочитать журнал, пересчитать список, написать пост, если список не тот, что уже в канале.
        True - пост написан."""
        state = self.reader.poll()
        rows = asks.stale(state, self.clock())
        if self.posted is None:
            self.posted = last_post(state)
        if rows == self.posted or (not rows and self.posted is None):
            return False
        self.put({"plugin": CHANNEL, "text": body(rows), "channel": "plugin", "owner": False, "sender": NAME})
        self.posted = rows
        return True


def main():
    plugin = Plugin(STATE)
    print(f"напоминания: опрос журнала раз в {EVERY} с, список - в канал {CHANNEL}", flush=True)
    while True:
        try:
            plugin.tick()
        except (OSError, ValueError, KeyError) as e:
            print(f"напоминания: состояние хаба не прочиталось: {e}", flush=True)
            plugin.reader.state = None
        time.sleep(EVERY)


if __name__ == "__main__":
    main()

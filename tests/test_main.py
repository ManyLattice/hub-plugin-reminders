import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
hub_code = os.environ.get("HUB_CODE")
if hub_code:
    sys.path.insert(0, os.path.expanduser(hub_code))
try:
    import main  # noqa: E402
    from core import journal  # noqa: E402
except ImportError as e:
    raise unittest.SkipTest(f"hub core is not importable (set HUB_CODE to the hub code folder): {e}")

NOW = 1_800_000_000


def post(seq, plugin="x", text="t", sender="ext:x"):
    return {"seq": seq, "ts": NOW, "type": "ext.post", "entity": None,
            "data": {"plugin": plugin, "text": text, "channel": "plugin", "owner": False, "sender": sender}}


def ask_state(since, answered=False):
    a = {"id": "q1", "request_id": "r1", "tool": "AskUserQuestion", "since": since,
         "input": {"questions": [{"question": "Делаем так?", "options": [{"label": "Да"}, {"label": "Нет"}]}]}}
    return {"seq": 1, "delegations": {}, "feeds": {},
            "sessions": {"s": {"state": "idle", "asks": [a], "pending": [],
                               "answered": [{"request_id": "r1"}] if answered else []}}}


class Journal(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "journal.jsonl")
        self.write([post(1)])
        self.loads = 0

        def load(d):
            self.loads += 1
            return journal.load_state(d)
        self.reader = main.Reader(self.dir, load=load)

    def write(self, events, mode="w", tail=""):
        with open(self.path, mode, encoding="utf-8") as f:
            f.write("".join(json.dumps(e) + "\n" for e in events) + tail)

    def texts(self):
        return [p["text"] for p in self.reader.state["feeds"]["x"]]

    def test_the_whole_state_is_read_once_then_only_new_lines(self):
        self.reader.poll()
        self.reader.poll()
        self.write([post(2, text="a")], "a")
        self.reader.poll()
        self.write([post(3, text="b"), post(4, text="c")], "a")
        self.reader.poll()
        self.assertEqual(self.loads, 1)
        self.assertEqual(self.texts(), ["t", "a", "b", "c"])

    def test_a_line_still_being_written_waits_for_its_end(self):
        self.reader.poll()
        self.write([], "a", tail=json.dumps(post(2, text="a"))[:20])
        self.reader.poll()
        self.assertEqual(self.texts(), ["t"])
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(post(2, text="a"))[20:] + "\n")
        self.reader.poll()
        self.assertEqual(self.texts(), ["t", "a"])
        self.assertEqual(self.loads, 1)

    def test_rotation_reads_the_new_journal_whole(self):
        self.reader.poll()
        os.remove(self.path)
        self.write([post(7, text="new")])
        self.reader.poll()
        self.assertEqual(self.loads, 2)
        self.assertEqual(self.texts(), ["new"])

    def test_a_shorter_journal_is_read_whole(self):
        self.write([post(2, text="a")], "a")
        self.reader.poll()
        self.write([post(1, text="z")], "r+")
        with open(self.path, "r+", encoding="utf-8") as f:
            f.truncate(len(json.dumps(post(1, text="z"))) + 1)
        self.reader.poll()
        self.assertEqual(self.loads, 2)
        self.assertEqual(self.texts(), ["z"])

    def test_a_gap_in_numbers_reads_the_journal_whole(self):
        self.reader.poll()
        self.write([post(5, text="far")], "a")
        self.reader.poll()
        self.assertEqual(self.loads, 2)
        self.assertEqual(self.texts(), ["t", "far"])

    def test_lines_read_twice_are_not_folded_twice(self):
        st = os.stat(self.path)
        self.reader.poll()
        self.reader.offset = st.st_size - len(json.dumps(post(1))) - 1   # load_state read past the size taken before it
        self.write([post(2, text="a")], "a")
        self.reader.poll()
        self.assertEqual(self.texts(), ["t", "a"])
        self.assertEqual(self.loads, 1)


class FakeReader:

    def __init__(self, state):
        self.state, self.polls = state, 0

    def poll(self):
        self.polls += 1
        return self.state


class Posts(unittest.TestCase):

    def plugin(self, state, now):
        self.sent, self.now = [], [now]
        return main.Plugin("/x", reader=FakeReader(state), put=self.sent.append, clock=lambda: self.now[0])

    def asks_of(self, i=-1):
        return json.loads(self.sent[i]["text"])["asks"]

    def test_the_list_is_posted_only_when_it_changes(self):
        p = self.plugin(ask_state(NOW - 25 * 3600), NOW)
        self.assertTrue(p.tick())
        self.assertFalse(p.tick())
        self.assertEqual(len(self.sent), 1)
        self.assertEqual([a["id"] for a in self.asks_of()], ["q1"])
        self.assertEqual(self.sent[0]["plugin"], main.CHANNEL)
        p.reader.state = ask_state(NOW - 25 * 3600, answered=True)
        self.assertTrue(p.tick())
        self.assertEqual(self.asks_of(), [])

    def test_a_card_that_turns_a_day_old_is_posted_without_a_journal_change(self):
        p = self.plugin(ask_state(NOW - 23 * 3600), NOW)
        self.assertFalse(p.tick())
        self.now[0] += 2 * 3600
        self.assertTrue(p.tick())
        self.assertEqual([a["id"] for a in self.asks_of()], ["q1"])
        self.now[0] += 3600
        self.assertFalse(p.tick())
        self.assertEqual(len(self.sent), 1)

    def test_after_a_restart_the_same_list_is_not_posted_again(self):
        state = ask_state(NOW - 25 * 3600)
        first = self.plugin(state, NOW)
        first.tick()
        state["feeds"][main.CHANNEL] = [{"id": "p9", "by": f"плагин {main.NAME}", "text": self.sent[0]["text"]}]
        again = self.plugin(state, NOW)
        self.assertFalse(again.tick())
        self.assertEqual(self.sent, [])

    def test_a_market_plugin_finds_its_post_by_its_full_name(self):
        state = ask_state(NOW - 25 * 3600)
        with mock.patch.object(main, "NAME", "acme:reminders"):
            self.plugin(state, NOW).tick()
            state["feeds"][main.CHANNEL] = [{"id": "p8", "by": "плагин acme:reminders", "text": self.sent[0]["text"]},
                                            {"id": "p9", "by": "плагин acme:reminders", "text": "{}"}]
            self.assertFalse(self.plugin(state, NOW).tick())

    def test_a_session_post_in_the_channel_is_not_taken_for_the_list(self):
        state = ask_state(NOW - 25 * 3600)
        state["feeds"][main.CHANNEL] = [{"id": "p9", "by": "s", "text": json.dumps({"kind": "stale", "asks": []})}]
        p = self.plugin(state, NOW)
        self.assertTrue(p.tick())

    def test_nothing_is_posted_while_there_was_never_a_list(self):
        p = self.plugin(ask_state(NOW - 3600), NOW)
        self.assertFalse(p.tick())
        self.assertEqual(self.sent, [])

    def test_a_long_list_is_cut_to_fit_a_post(self):
        rows = [{"id": f"q{i}", "session": "s", "question": "в" * 200, "options": [], "since": NOW, "revived": False}
                for i in range(200)]
        text = main.body(rows)
        self.assertLessEqual(len(text), main.POST_MAX)
        got = json.loads(text)["asks"]
        self.assertGreater(len(got), 10)
        self.assertEqual(got, rows[:len(got)])


if __name__ == "__main__":
    unittest.main()

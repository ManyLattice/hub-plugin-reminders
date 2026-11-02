import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import asks  # noqa: E402

NOW = 1_793_600_000
H = 3600


def card(qid, ago_h, text="Делаем так?", **extra):
    return {"id": qid, "request_id": f"r-{qid}", "tool": "AskUserQuestion", "since": NOW - ago_h * H, "interactive": True,
            "input": {"questions": [{"question": text, "options": [{"label": "Да (Recommended)"}, {"label": "Нет"}]}]}, **extra}


def sess(asks_=(), **extra):
    return {"state": "idle", "asks": list(asks_), "pending": [], "answered": [], **extra}


class StaleAsks(unittest.TestCase):

    def rows(self, sessions, delegations=None):
        return asks.stale({"sessions": sessions, "delegations": delegations or {}}, NOW)

    def test_live_web_dev_card_is_found(self):
        rows = self.rows({"alpha-lab": sess([card("q1001", 58.5, "Делаем так? Отчёты «Приложения A» уже живут в панели", delegation="d2001")])},
                         {"d2001": {"state": "waiting-owner"}})
        self.assertEqual([(r["id"], r["session"]) for r in rows], [("q1001", "alpha-lab")])
        self.assertEqual(rows[0]["options"], ["Да", "Нет"])
        self.assertFalse(rows[0]["revived"])

    def test_fresh_and_too_old_are_dropped(self):
        rows = self.rows({"s": sess([card("q1", 23, "A?"), card("q2", 25, "B?"), card("q3", 14 * 24 - 1, "C?"), card("q4", 14 * 24 + 1, "D?")])})
        self.assertEqual(sorted(r["id"] for r in rows), ["q2", "q3"])

    def test_gone_sessions_dropped(self):
        rows = self.rows({"a": sess([card("q1", 30)], state="removed"), "b": sess([card("q2", 30)], state="retired"),
                          "c": sess([card("q3", 30)], state="parked")})
        self.assertEqual([r["session"] for r in rows], ["c"])

    def test_task_over_dropped(self):
        for st in ("replied", "stopped", "closed", "archived"):
            self.assertEqual(self.rows({"s": sess([card("q1", 30, delegation="d1")])}, {"d1": {"state": st}}), [], st)
        self.assertEqual(len(self.rows({"s": sess([card("q1", 30, delegation="d1")])}, {"d1": {"state": "waiting-owner"}})), 1)

    def test_answered_dropped(self):
        self.assertEqual(self.rows({"s": sess([card("q1", 30)], answered=[{"request_id": "r-q1"}])}), [])

    def test_waiting_for_owner_return_dropped(self):
        self.assertEqual(self.rows({"s": sess([card("q1", 30, away=True)])}), [])
        self.assertEqual(len(self.rows({"s": sess([card("q1", 30, away=True, back_at=NOW - 30 * H)])})), 1)
        self.assertEqual(self.rows({"s": sess([card("q1", 30, away=True, back_at=NOW - 2 * H)])}), [])

    def test_question_asked_again_is_not_stale(self):
        again = {"request_id": "r-new", "tool": "AskUserQuestion", "input": card("x", 0)["input"]}
        self.assertEqual(self.rows({"s": sess([card("q1", 30)], pending=[again])}), [])
        self.assertEqual(self.rows({"s": sess([card("q1", 30), card("q2", 1)])}), [])

    def test_same_question_shown_once(self):
        rows = self.rows({"s": sess([card("q1", 30), card("q2", 40, text="  делаем ТАК? ")])})
        self.assertEqual([r["id"] for r in rows], ["q1"])

    def test_revived_by_core_uses_core_key(self):
        a = card("q1", 30, text="Делаем так?")
        two = {"input": {"questions": [{"question": "Одно?"}, {"question": "Другое?"}]}}
        self.assertEqual((asks.key(a), asks.key(two)), ("271f93508ff3", "59545f591656"))   # значения core.askexpired.key (PR #356)
        rows = self.rows({"s": sess([a], revived={asks.key(a): NOW - H})})
        self.assertTrue(rows[0]["revived"])

    def test_other_tools_ignored(self):
        self.assertEqual(self.rows({"s": sess([{**card("q1", 30), "tool": "Bash"}])}), [])

    def test_oldest_first(self):
        rows = self.rows({"b": sess([card("q2", 30, "B?")]), "a": sess([card("q1", 50, "A?")])})
        self.assertEqual([r["id"] for r in rows], ["q1", "q2"])


if __name__ == "__main__":
    unittest.main()

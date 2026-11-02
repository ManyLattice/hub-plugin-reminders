import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
hub_code = os.environ.get("HUB_CODE")
if hub_code:
    sys.path.insert(0, os.path.expanduser(hub_code))
try:
    import main  # noqa: E402
except ImportError as e:
    raise unittest.SkipTest(f"hub core is not importable (set HUB_CODE to the hub code folder): {e}")


class Page(unittest.TestCase):

    def test_only_the_hub_page(self):
        p = main.Plugin("/x", load=lambda d: {"sessions": {}})
        self.assertEqual(p.act("/asks", "")[0], 403)
        self.assertEqual(p.act("/asks", "http://evil.example")[0], 403)
        self.assertEqual(p.act("/asks", f"http://127.0.0.1:{main.WEB_PORT}")[0], 200)
        self.assertEqual(p.act("/other", f"http://127.0.0.1:{main.WEB_PORT}")[0], 404)

    def test_state_is_read_not_more_often_than_the_cache(self):
        t, n = [1000.0], [0]

        def load(d):
            n[0] += 1
            return {"sessions": {}}
        p = main.Plugin("/x", load=load, clock=lambda: t[0])
        p.asks(); p.asks()
        self.assertEqual(n[0], 1)
        t[0] += main.CACHE
        p.asks()
        self.assertEqual(n[0], 2)

    def test_unreadable_state_is_503(self):
        def load(d):
            raise OSError("нет файла")
        self.assertEqual(main.Plugin("/x", load=load).act("/asks", f"http://127.0.0.1:{main.WEB_PORT}")[0], 503)


if __name__ == "__main__":
    unittest.main()

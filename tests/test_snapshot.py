import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "site" / "data" / "market.json"
WATCHLIST = ROOT / "config" / "watchlist.json"
FETCHER = ROOT / "scripts" / "fetch_market_data.py"


class SnapshotTests(unittest.TestCase):
    def test_snapshot_shape(self):
        payload = json.loads(SNAPSHOT.read_text())
        self.assertIn(payload["mode"], {"demo", "live", "degraded"})
        self.assertTrue(payload["symbols"])
        self.assertIn(payload["overnight"]["status"], {"ok", "partial", "unavailable"})
        self.assertIn("asia", payload["overnight"])
        self.assertIn("news", payload["overnight"])
        for item in payload["symbols"]:
            self.assertRegex(item["symbol"], r"^[A-Z][A-Z0-9.-]{0,9}$")
            if item["price"] is not None:
                self.assertGreater(item["price"], 0)
            self.assertIsInstance(item["sparkline"], list)

    def test_snapshot_matches_default_watchlist(self):
        payload = json.loads(SNAPSHOT.read_text())
        watchlist = json.loads(WATCHLIST.read_text())
        self.assertEqual(
            [item["symbol"] for item in payload["symbols"]],
            [item["symbol"] for item in watchlist],
        )

    def test_number_rejects_non_finite_values(self):
        sys.modules.setdefault("yfinance", types.SimpleNamespace())
        spec = importlib.util.spec_from_file_location("fetch_market_data", FETCHER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIsNone(module.number(float("nan")))
        self.assertIsNone(module.number(float("inf")))
        self.assertEqual(module.number("42.5"), 42.5)

    def test_headline_signal_identifies_market_risk(self):
        sys.modules.setdefault("yfinance", types.SimpleNamespace())
        spec = importlib.util.spec_from_file_location("fetch_market_data", FETCHER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        category, signal = module.headline_signal("Trump escalates tariffs as trade conflict grows")
        self.assertEqual(category, "Policy")
        self.assertLess(signal, 0)

        category, signal = module.headline_signal("Nvidia surges after AI chip breakthrough")
        self.assertEqual(category, "AI & chips")
        self.assertGreater(signal, 0)

        category, signal = module.headline_signal("University honors faculty with annual awards")
        self.assertEqual(category, "Markets")
        self.assertEqual(signal, 0)


if __name__ == "__main__":
    unittest.main()

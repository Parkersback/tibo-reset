from contextlib import redirect_stdout
from io import StringIO
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "check_static_under_test", ROOT / "tests" / "check_static.py"
)
assert SPEC and SPEC.loader
check_static = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_static)

REQUIRED_DATA_PATHS = (
    "data/prediction.json",
    "data/prediction_history.json",
    "data/tweets.json",
    "data/model_performance.json",
    "data/reset_history.json",
)


class StaticContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=ROOT)
        self.site = Path(self.temp_dir.name) / "site"
        (self.site / "data").mkdir(parents=True)
        check_static.SITE = self.site
        self._write_valid_site()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write_valid_site(self) -> None:
        sections = "\n".join(
            f'<section id="{section_id}"></section>'
            for section_id in check_static.REQUIRED_SECTION_IDS
        )
        (self.site / "index.html").write_text(sections, encoding="utf-8")
        (self.site / "styles.css").write_text("body {}", encoding="utf-8")
        (self.site / "favicon.svg").write_text("<svg></svg>", encoding="utf-8")
        (self.site / "app.js").write_text(
            """
const messages = {"zh-CN": {}, "en": {}};
const storageKey = "tibo-reset-language";
const edgeConfig = "./edge-config.json";
const sources = [
  "./data/prediction.json",
  "./data/prediction_history.json",
  "./data/tweets.json",
  "./data/model_performance.json",
  "./data/reset_history.json",
];
""".strip(),
            encoding="utf-8",
        )
        (self.site / "health.json").write_text(
            json.dumps(
                {"app": "tibo-reset", "status": "ok", "schema": 1},
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        (self.site / "edge-config.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "edgeMode": "off",
                    "edgeSnapshotUrl": "",
                    "timeoutMs": 4000,
                    "maxAgeSeconds": 420,
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        for data_path in REQUIRED_DATA_PATHS:
            (self.site / data_path).write_text("{}", encoding="utf-8")

    def _run_check(self) -> tuple[int, str]:
        output = StringIO()
        with redirect_stdout(output):
            result = check_static.main()
        return result, output.getvalue()

    def test_valid_contract_passes(self) -> None:
        result, output = self._run_check()
        self.assertEqual(0, result)
        self.assertIn("STATIC CONTRACT PASS", output)

    def test_language_key_does_not_match_incidental_en_substring(self) -> None:
        app_path = self.site / "app.js"
        app_path.write_text(
            app_path.read_text(encoding="utf-8").replace(', "en": {}', "")
            + '\nconst sentence = "prediction enabled";',
            encoding="utf-8",
        )

        result, output = self._run_check()

        self.assertEqual(1, result)
        self.assertIn("missing language key in site/app.js: en", output)

    def test_html_comment_does_not_supply_an_element_id(self) -> None:
        html_path = self.site / "index.html"
        html_path.write_text(
            html_path.read_text(encoding="utf-8").replace(
                '<section id="forecast"></section>',
                '<!-- <section id="forecast"></section> -->',
            ),
            encoding="utf-8",
        )

        result, output = self._run_check()

        self.assertEqual(1, result)
        self.assertIn("missing section id in site/index.html: forecast", output)

    def test_html_parser_accepts_whitespace_around_equals(self) -> None:
        html_path = self.site / "index.html"
        html_path.write_text(
            html_path.read_text(encoding="utf-8").replace("id=", "id = "),
            encoding="utf-8",
        )

        result, output = self._run_check()

        self.assertEqual(0, result)
        self.assertIn("STATIC CONTRACT PASS", output)

    def test_health_object_must_match_exactly(self) -> None:
        (self.site / "health.json").write_text(
            '{"app":"tibo-reset","status":"ok","schema":true}',
            encoding="utf-8",
        )

        result, output = self._run_check()

        self.assertEqual(1, result)
        self.assertIn("health object mismatch in site/health.json", output)

    def test_data_file_must_exist(self) -> None:
        (self.site / REQUIRED_DATA_PATHS[0]).unlink()

        result, output = self._run_check()

        self.assertEqual(1, result)
        self.assertIn("missing required file: site/data/prediction.json", output)

    def test_edge_config_rejects_active_mode_without_exact_https_bundle_path(self) -> None:
        (self.site / "edge-config.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "edgeMode": "primary",
                    "edgeSnapshotUrl": "https://edge.example.test/not-the-bundle",
                    "timeoutMs": 4000,
                    "maxAgeSeconds": 420,
                }
            ),
            encoding="utf-8",
        )

        result, output = self._run_check()

        self.assertEqual(1, result)
        self.assertIn("edge config mismatch in site/edge-config.json", output)

    def test_invalid_data_json_is_reported_without_exception(self) -> None:
        (self.site / REQUIRED_DATA_PATHS[0]).write_text(
            "{", encoding="utf-8"
        )

        result, output = self._run_check()

        self.assertEqual(1, result)
        self.assertIn("invalid JSON in site/data/prediction.json", output)

    def test_invalid_utf8_is_reported_without_exception(self) -> None:
        (self.site / "app.js").write_bytes(b"\xff")

        result, output = self._run_check()

        self.assertEqual(1, result)
        self.assertIn("invalid UTF-8 in site/app.js", output)


if __name__ == "__main__":
    unittest.main()

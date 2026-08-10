from contextlib import contextmanager, redirect_stdout
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from scripts import sync_data


def prediction_payload(marker: str = "fresh") -> dict:
    return {
        "updated_at": "2026-08-11T00:00:00Z",
        "prediction": {
            "within_5h": 0.1,
            "within_24h": 0.4,
            "within_48h": 0.7,
        },
        "marker": marker,
    }


def valid_payload_for(source: sync_data.Source):
    if source.name == "prediction.json":
        return prediction_payload()
    if source.name == "model_performance.json":
        return {"total_predictions": 12, "horizons": {}}
    if source.expected_type is list:
        return [{"source": source.name}]
    return {key: f"value-for-{key}" for key in source.required_keys}


@contextmanager
def local_json_server(body: bytes):
    class Handler(BaseHTTPRequestHandler):
        observed_user_agent = None

        def do_GET(self) -> None:
            type(self).observed_user_agent = self.headers.get("User-Agent")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/payload.json", Handler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class FetchJsonTests(unittest.TestCase):
    def test_fetch_json_uses_required_user_agent(self) -> None:
        body = json.dumps({"answer": 42}).encode("utf-8")
        with local_json_server(body) as (url, handler):
            source = sync_data.Source("payload.json", url)

            payload = sync_data.fetch_json(source, timeout=2.0)

        self.assertEqual({"answer": 42}, payload)
        self.assertEqual(
            "TiboResetMirror/1.0 (+https://github.com/Parkersback/tibo-reset)",
            handler.observed_user_agent,
        )

    def test_fetch_json_rejects_invalid_json(self) -> None:
        with local_json_server(b"{not-json") as (url, _handler):
            source = sync_data.Source("payload.json", url)

            with self.assertRaises(json.JSONDecodeError):
                sync_data.fetch_json(source, timeout=2.0)


class ValidationTests(unittest.TestCase):
    def test_validate_payload_rejects_wrong_top_level_type(self) -> None:
        cases = (
            (sync_data.Source("object.json", "https://example.test", expected_type=dict), []),
            (sync_data.Source("array.json", "https://example.test", expected_type=list), {}),
        )
        for source, payload in cases:
            with self.subTest(source=source.name):
                with self.assertRaisesRegex(ValueError, "expected"):
                    sync_data.validate_payload(source, payload)

    def test_validate_payload_rejects_missing_required_key(self) -> None:
        source = sync_data.Source(
            "model_performance.json",
            "https://example.test",
            required_keys=("total_predictions", "horizons"),
        )

        with self.assertRaisesRegex(ValueError, "horizons"):
            sync_data.validate_payload(source, {"total_predictions": 3})

    def test_validate_payload_rejects_each_missing_prediction_horizon(self) -> None:
        source = sync_data.Source(
            "prediction.json",
            "https://example.test",
            required_keys=("updated_at", "prediction"),
        )
        for missing_key in ("within_5h", "within_24h", "within_48h"):
            payload = prediction_payload()
            del payload["prediction"][missing_key]
            with self.subTest(missing_key=missing_key):
                with self.assertRaisesRegex(ValueError, missing_key):
                    sync_data.validate_payload(source, payload)


class AtomicWriteTests(unittest.TestCase):
    def test_atomic_write_json_leaves_no_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            target = output_dir / "payload.json"

            sync_data.atomic_write_json(target, {"message": "中文"})

            self.assertEqual({"message": "中文"}, json.loads(target.read_text(encoding="utf-8")))
            self.assertIn("中文", target.read_text(encoding="utf-8"))
            self.assertEqual(["payload.json"], sorted(path.name for path in output_dir.iterdir()))


class SyncAllTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output_dir = Path(self.temp_dir.name) / "data"
        self.sources = (
            sync_data.Source(
                "prediction.json",
                "https://example.test/prediction.json",
                required_keys=("updated_at", "prediction"),
            ),
            sync_data.Source(
                "tweets.json",
                "https://example.test/tweets.json",
                expected_type=list,
            ),
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_successful_sync_writes_every_fresh_payload(self) -> None:
        payloads = {
            "prediction.json": prediction_payload(),
            "tweets.json": [{"id": "tweet-1"}],
        }

        with patch.object(
            sync_data,
            "fetch_json",
            side_effect=lambda source, timeout: payloads[source.name],
        ) as fetcher:
            succeeded = sync_data.sync_all(self.output_dir, self.sources, timeout=7.5)

        self.assertTrue(succeeded)
        for name, expected in payloads.items():
            actual = json.loads((self.output_dir / name).read_text(encoding="utf-8"))
            self.assertEqual(expected, actual)
        self.assertEqual(2, fetcher.call_count)
        self.assertTrue(all(call.args[1] == 7.5 for call in fetcher.call_args_list))

    def test_invalid_fresh_payload_preserves_valid_cache_and_degrades(self) -> None:
        source = self.sources[0]
        self.output_dir.mkdir(parents=True)
        target = self.output_dir / source.name
        old_payload = prediction_payload(marker="cached")
        old_text = json.dumps(old_payload, ensure_ascii=False, indent=2) + "\n"
        target.write_text(old_text, encoding="utf-8")

        with patch.object(sync_data, "fetch_json", return_value={"bad": "payload"}):
            succeeded = sync_data.sync_all(self.output_dir, (source,))

        self.assertTrue(succeeded)
        self.assertEqual(old_text, target.read_text(encoding="utf-8"))
        status = json.loads((self.output_dir / "sync-status.json").read_text(encoding="utf-8"))
        self.assertEqual("degraded", status["overall_status"])
        self.assertEqual("cached", status["sources"][0]["status"])
        self.assertIn("error", status["sources"][0])

    def test_fetch_failure_without_cache_marks_failed_and_returns_false(self) -> None:
        with patch.object(sync_data, "fetch_json", side_effect=OSError("offline")):
            succeeded = sync_data.sync_all(self.output_dir, (self.sources[0],))

        self.assertFalse(succeeded)
        status = json.loads((self.output_dir / "sync-status.json").read_text(encoding="utf-8"))
        self.assertEqual("failed", status["overall_status"])
        self.assertEqual("failed", status["sources"][0]["status"])
        self.assertIn("offline", status["sources"][0]["error"])
        self.assertFalse((self.output_dir / self.sources[0].name).exists())

    def test_fetch_failure_keeps_parseable_legacy_json_cache(self) -> None:
        source = self.sources[0]
        self.output_dir.mkdir(parents=True)
        target = self.output_dir / source.name
        old_text = '{"legacy_schema":true}\n'
        target.write_text(old_text, encoding="utf-8")

        with patch.object(sync_data, "fetch_json", side_effect=OSError("offline")):
            succeeded = sync_data.sync_all(self.output_dir, (source,))

        self.assertTrue(succeeded)
        self.assertEqual(old_text, target.read_text(encoding="utf-8"))
        status = json.loads((self.output_dir / "sync-status.json").read_text(encoding="utf-8"))
        self.assertEqual("degraded", status["overall_status"])
        self.assertEqual("cached", status["sources"][0]["status"])

    def test_sync_status_has_schema_timestamp_urls_and_conditional_errors(self) -> None:
        with patch.object(
            sync_data,
            "fetch_json",
            side_effect=lambda source, timeout: valid_payload_for(source),
        ):
            self.assertTrue(sync_data.sync_all(self.output_dir, self.sources))

        status = json.loads((self.output_dir / "sync-status.json").read_text(encoding="utf-8"))
        self.assertEqual({"schema", "synced_at", "overall_status", "sources"}, set(status))
        self.assertEqual(1, status["schema"])
        self.assertEqual("ok", status["overall_status"])
        self.assertTrue(status["synced_at"].endswith("Z"))
        datetime.fromisoformat(status["synced_at"].replace("Z", "+00:00"))
        self.assertEqual(
            [source.name for source in self.sources],
            [entry["name"] for entry in status["sources"]],
        )
        for source, entry in zip(self.sources, status["sources"], strict=True):
            self.assertEqual(
                {"name": source.name, "url": source.url, "status": "fresh"},
                entry,
            )


class CommandLineTests(unittest.TestCase):
    def test_cli_returns_zero_for_ok_and_one_when_required_cache_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as ok_dir:
            with patch.object(
                sync_data,
                "fetch_json",
                side_effect=lambda source, timeout: valid_payload_for(source),
            ):
                output = StringIO()
                with redirect_stdout(output):
                    exit_code = sync_data.main(["--output-dir", ok_dir])
            self.assertEqual(0, exit_code)
            self.assertIn("ok", output.getvalue().lower())
            self.assertIn("fresh=5", output.getvalue())

        with tempfile.TemporaryDirectory() as failed_dir:
            with patch.object(sync_data, "fetch_json", side_effect=OSError("offline")):
                output = StringIO()
                with redirect_stdout(output):
                    exit_code = sync_data.main(["--output-dir", failed_dir])
            self.assertEqual(1, exit_code)
            self.assertIn("failed", output.getvalue().lower())
            self.assertIn("failed=5", output.getvalue())


if __name__ == "__main__":
    unittest.main()

from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from scripts import sync_data


ROOT = Path(__file__).resolve().parents[1]
TWEET_FIELDS = (
    "timestamp",
    "author",
    "text",
    "source",
    "url",
    "authority_score",
)


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


def tweet_payload(**overrides) -> dict:
    payload = {
        "timestamp": "2026-01-01T00:00:00Z",
        "author": "Tibo",
        "text": "A safe reset signal.",
        "source": "tibo_rss",
        "url": "https://x.com/thsottiaux/status/123",
        "authority_score": 1.0,
    }
    payload.update(overrides)
    return payload


def valid_payload_for(source: sync_data.Source):
    if source.name == "prediction.json":
        return prediction_payload()
    if source.name == "prediction_history.json":
        return [
            {
                "prediction_time": "2026-01-01T00:00:00Z",
                "prediction": prediction_payload()["prediction"],
                "signals": {},
                "actual_result": None,
                "resolved_at": None,
            }
        ]
    if source.name == "tweets.json":
        return [tweet_payload()]
    if source.name == "model_performance.json":
        return {
            "total_predictions": 12,
            "resolved_predictions": 10,
            "overall_brier_score": 0.2,
            "overall_accuracy": 0.8,
            "horizons": [
                {
                    "horizon_hours": 5,
                    "total": 10,
                    "brier_score": 0.2,
                    "accuracy": 0.8,
                    "calibration_error": 0.1,
                    "bins": [],
                }
            ],
            "updated_at": "2026-01-01T00:00:00Z",
        }
    if source.name == "reset_history.json":
        return [
            {
                "reset_time": "2026-01-01T00:00:00Z",
                "source": "openai_status",
                "confidence": 1.0,
                "notes": "Verified reset.",
            }
        ]
    if source.expected_type is list:
        return [
            {
                key: f"value-for-{key}"
                for key in source.item_required_keys
            }
        ]
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

    def test_fetch_json_rejects_body_larger_than_eight_mib(self) -> None:
        oversized_body = b"x" * (8 * 1024 * 1024 + 1)
        with local_json_server(oversized_body) as (url, _handler):
            source = sync_data.Source("payload.json", url)

            with self.assertRaisesRegex(ValueError, "8 MiB"):
                sync_data.fetch_json(source, timeout=5.0)


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

    def test_default_list_sources_define_stable_item_contracts(self) -> None:
        expected_contracts = {
            "prediction_history.json": ("prediction_time", "prediction"),
            "tweets.json": TWEET_FIELDS,
            "reset_history.json": (
                "reset_time",
                "source",
                "confidence",
                "notes",
            ),
        }

        actual_contracts = {
            source.name: source.item_required_keys
            for source in sync_data.DEFAULT_SOURCES
            if source.expected_type is list
        }

        self.assertEqual(expected_contracts, actual_contracts)

    def test_default_list_sources_have_reasonable_maximum_lengths(self) -> None:
        maximums = {
            source.name: source.max_items
            for source in sync_data.DEFAULT_SOURCES
            if source.expected_type is list
        }

        self.assertEqual(
            {
                "prediction_history.json": 10_000,
                "tweets.json": 500,
                "reset_history.json": 2_000,
            },
            maximums,
        )

    def test_validate_payload_rejects_non_object_list_item(self) -> None:
        source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "tweets.json"
        )

        with self.assertRaisesRegex(ValueError, "item 0.*dict"):
            sync_data.validate_payload(source, ["not-an-object"])

    def test_validate_payload_rejects_missing_list_item_key(self) -> None:
        for source in sync_data.DEFAULT_SOURCES:
            if source.expected_type is not list:
                continue
            payload = valid_payload_for(source)
            missing_key = source.item_required_keys[0]
            del payload[0][missing_key]
            with self.subTest(source=source.name, missing_key=missing_key):
                with self.assertRaisesRegex(ValueError, missing_key):
                    sync_data.validate_payload(source, payload)

    def test_validate_payload_rejects_list_over_source_limit(self) -> None:
        source = sync_data.Source(
            "array.json",
            "https://example.test",
            expected_type=list,
            max_items=1,
        )

        with self.assertRaisesRegex(ValueError, "at most 1"):
            sync_data.validate_payload(source, [{}, {}])

    def test_prediction_probabilities_reject_wrong_nan_and_out_of_range(self) -> None:
        source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "prediction.json"
        )
        for bad_value in (True, "0.5", float("nan"), -0.01, 1.01):
            payload = prediction_payload()
            payload["prediction"]["within_5h"] = bad_value
            with self.subTest(bad_value=bad_value):
                with self.assertRaisesRegex(ValueError, "within_5h"):
                    sync_data.validate_payload(source, payload)

    def test_prediction_history_requires_valid_prediction_and_iso_time(self) -> None:
        source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "prediction_history.json"
        )
        invalid_payloads = (
            [{**valid_payload_for(source)[0], "prediction_time": "not-iso"}],
            [
                {
                    **valid_payload_for(source)[0],
                    "prediction": {
                        "within_5h": 0.1,
                        "within_24h": float("nan"),
                        "within_48h": 0.8,
                    },
                }
            ],
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    sync_data.validate_payload(source, payload)

    def test_model_performance_rejects_invalid_totals_metrics_and_horizons(self) -> None:
        source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "model_performance.json"
        )
        cases = (
            ("total_predictions", True),
            ("overall_accuracy", 1.1),
            ("horizons", {}),
        )
        for key, value in cases:
            payload = valid_payload_for(source)
            payload[key] = value
            with self.subTest(key=key, value=value):
                with self.assertRaisesRegex(ValueError, key):
                    sync_data.validate_payload(source, payload)

    def test_reset_history_rejects_invalid_time_confidence_and_long_notes(self) -> None:
        source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "reset_history.json"
        )
        cases = (
            ("reset_time", "not-iso"),
            ("confidence", float("nan")),
            ("notes", "x" * 501),
            ("source", ""),
        )
        for key, value in cases:
            payload = valid_payload_for(source)
            payload[0][key] = value
            with self.subTest(key=key):
                with self.assertRaisesRegex(ValueError, key):
                    sync_data.validate_payload(source, payload)


class TweetSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "tweets.json"
        )

    def test_canonicalize_tweets_normalizes_and_truncates_public_excerpt(self) -> None:
        raw = tweet_payload(
            text="  " + ("x" * 400) + "\n\t",
            extra_private_field="must not be mirrored",
        )

        canonical = sync_data.canonicalize_payload(self.source, [raw])

        self.assertEqual(set(TWEET_FIELDS), set(canonical[0]))
        self.assertNotIn("extra_private_field", canonical[0])
        self.assertLessEqual(len(canonical[0]["text"]), 361)
        self.assertTrue(canonical[0]["text"].endswith("…"))
        self.assertNotIn("\n", canonical[0]["text"])
        sync_data.validate_payload(self.source, canonical)

    def test_tweets_reject_malicious_lookalike_domains(self) -> None:
        payloads = (
            [tweet_payload(url="https://x.com.evil.test/thsottiaux/status/1")],
            [
                tweet_payload(
                    source="community_rss",
                    author="/u/example",
                    url="https://reddit.com.evil.test/r/chatgpt/1",
                )
            ],
            [
                tweet_payload(
                    source="openai_rss",
                    author="OpenAI",
                    url="https://openai.com.evil.test/news",
                )
            ],
        )
        for payload in payloads:
            with self.subTest(url=payload[0]["url"]):
                with self.assertRaisesRegex(ValueError, "url"):
                    sync_data.validate_payload(self.source, payload)

    def test_tweets_reject_source_impersonation_and_unknown_sources(self) -> None:
        payloads = (
            [tweet_payload(author="OpenAI")],
            [
                tweet_payload(
                    source="openai_status",
                    author="Tibo",
                    url="https://status.openai.com/incidents/1",
                )
            ],
            [tweet_payload(source="tibo_rss_official")],
        )
        for payload in payloads:
            with self.subTest(source=payload[0]["source"], author=payload[0]["author"]):
                with self.assertRaises(ValueError):
                    sync_data.validate_payload(self.source, payload)

    def test_tweets_reject_timestamp_more_than_24_hours_in_future(self) -> None:
        future = datetime.now(timezone.utc) + timedelta(hours=25)
        payload = [tweet_payload(timestamp=future.isoformat().replace("+00:00", "Z"))]

        with self.assertRaisesRegex(ValueError, "timestamp"):
            sync_data.validate_payload(self.source, payload)

    def test_tweets_accept_valid_community_and_official_sources(self) -> None:
        payload = [
            tweet_payload(
                source="community_rss",
                author="/u/example",
                url="https://www.reddit.com/r/chatgpt/comments/1",
                authority_score=0.5,
            ),
            tweet_payload(
                source="openai_status",
                author="OpenAI Status",
                url="https://status.openai.com/incidents/1",
            ),
        ]

        sync_data.validate_payload(self.source, payload)


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
                "items.json",
                "https://example.test/items.json",
                expected_type=list,
                item_required_keys=("id",),
            ),
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_successful_sync_writes_every_fresh_payload(self) -> None:
        payloads = {
            "prediction.json": prediction_payload(),
            "items.json": [{"id": "item-1"}],
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

    def test_malicious_fresh_tweets_do_not_overwrite_valid_cache(self) -> None:
        source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "tweets.json"
        )
        self.output_dir.mkdir(parents=True)
        target = self.output_dir / source.name
        old_payload = [tweet_payload(text="known safe cache")]
        old_text = json.dumps(old_payload, ensure_ascii=False, indent=2) + "\n"
        target.write_text(old_text, encoding="utf-8")
        malicious = [
            tweet_payload(
                text="phishing payload",
                url="https://x.com.attacker.example/thsottiaux/status/1",
            )
        ]

        with patch.object(sync_data, "fetch_json", return_value=malicious):
            succeeded = sync_data.sync_all(self.output_dir, (source,))

        self.assertTrue(succeeded)
        self.assertEqual(old_text, target.read_text(encoding="utf-8"))
        status = json.loads((self.output_dir / "sync-status.json").read_text(encoding="utf-8"))
        self.assertEqual("degraded", status["overall_status"])
        self.assertEqual("cached", status["sources"][0]["status"])

    def test_sync_writes_only_canonicalized_tweet_excerpt(self) -> None:
        source = next(
            source
            for source in sync_data.DEFAULT_SOURCES
            if source.name == "tweets.json"
        )
        raw = [
            tweet_payload(
                text="x" * 500,
                upstream_metadata={"private": "drop"},
            )
        ]

        with patch.object(sync_data, "fetch_json", return_value=raw):
            succeeded = sync_data.sync_all(self.output_dir, (source,))

        self.assertTrue(succeeded)
        stored = json.loads((self.output_dir / source.name).read_text(encoding="utf-8"))
        self.assertEqual(set(TWEET_FIELDS), set(stored[0]))
        self.assertNotIn("upstream_metadata", stored[0])
        self.assertLessEqual(len(stored[0]["text"]), 361)
        self.assertTrue(stored[0]["text"].endswith("…"))

    def test_fetch_failure_rejects_parseable_but_invalid_cache(self) -> None:
        source = self.sources[0]
        self.output_dir.mkdir(parents=True)
        target = self.output_dir / source.name
        old_text = '{"legacy_schema":true}\n'
        target.write_text(old_text, encoding="utf-8")

        with patch.object(sync_data, "fetch_json", side_effect=OSError("offline")):
            succeeded = sync_data.sync_all(self.output_dir, (source,))

        self.assertFalse(succeeded)
        self.assertEqual(old_text, target.read_text(encoding="utf-8"))
        status = json.loads((self.output_dir / "sync-status.json").read_text(encoding="utf-8"))
        self.assertEqual("failed", status["overall_status"])
        self.assertEqual("failed", status["sources"][0]["status"])

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
                {
                    "name": source.name,
                    "url": source.url,
                    "status": "fresh",
                    "error": None,
                },
                entry,
            )


class RealMirrorContractTests(unittest.TestCase):
    def test_checked_in_real_output_passes_every_strict_source_contract(self) -> None:
        data_dir = ROOT / "site" / "data"
        for source in sync_data.DEFAULT_SOURCES:
            with self.subTest(source=source.name):
                path = data_dir / source.name
                self.assertLessEqual(path.stat().st_size, 8 * 1024 * 1024)
                payload = json.loads(path.read_text(encoding="utf-8"))
                sync_data.validate_payload(source, payload)

        tweets = json.loads((data_dir / "tweets.json").read_text(encoding="utf-8"))
        self.assertTrue(tweets)
        self.assertTrue(all(set(item) == set(TWEET_FIELDS) for item in tweets))
        self.assertLessEqual(max(len(item["text"]) for item in tweets), 361)


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
            for source in sync_data.DEFAULT_SOURCES:
                (Path(failed_dir) / source.name).write_text(
                    '{"legacy_schema":true}\n', encoding="utf-8"
                )
            with patch.object(sync_data, "fetch_json", side_effect=OSError("offline")):
                output = StringIO()
                with redirect_stdout(output):
                    exit_code = sync_data.main(["--output-dir", failed_dir])
            self.assertEqual(1, exit_code)
            self.assertIn("failed", output.getvalue().lower())
            self.assertIn("failed=5", output.getvalue())


if __name__ == "__main__":
    unittest.main()

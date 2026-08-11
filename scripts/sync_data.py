import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any
from urllib.parse import urlsplit
import urllib.request


USER_AGENT = "TiboResetMirror/1.0 (+https://github.com/Parkersback/tibo-reset)"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
PREDICTION_HORIZONS = ("within_5h", "within_24h", "within_48h")
TWEET_PUBLIC_FIELDS = (
    "timestamp",
    "author",
    "text",
    "source",
    "url",
    "authority_score",
)
TIBO_AUTHORS = frozenset(("Tibo", "thsottiaux"))
OFFICIAL_TWEET_SOURCES = frozenset(
    ("openai_rss", "openai_status", "status_rss", "release_rss")
)
OFFICIAL_AUTHORS = frozenset(
    (
        "OpenAI",
        "OpenAI Status",
        "OpenAI News",
        "OpenAI Developers",
        "ChatGPT",
        "@OpenAI",
        "@OpenAIDevs",
        "@ChatGPTapp",
    )
)


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    required_keys: tuple[str, ...] = ()
    expected_type: type[dict] | type[list] = dict
    item_required_keys: tuple[str, ...] = ()
    max_items: int | None = None


DEFAULT_SOURCES = (
    Source(
        "prediction.json",
        "https://willtiboreset.xyz/data/prediction.json",
        required_keys=("updated_at", "prediction"),
    ),
    Source(
        "prediction_history.json",
        "https://willtiboreset.xyz/data/prediction_history.json",
        expected_type=list,
        item_required_keys=("prediction_time", "prediction"),
        max_items=10_000,
    ),
    Source(
        "tweets.json",
        "https://willtiboreset.xyz/data/tweets.json",
        expected_type=list,
        item_required_keys=TWEET_PUBLIC_FIELDS,
        max_items=500,
    ),
    Source(
        "model_performance.json",
        "https://willtiboreset.xyz/data/model_performance.json",
        required_keys=(
            "total_predictions",
            "resolved_predictions",
            "overall_brier_score",
            "overall_accuracy",
            "horizons",
            "updated_at",
        ),
    ),
    Source(
        "reset_history.json",
        "https://raw.githubusercontent.com/EvanProgramming/willtiboreset/main/data/reset_history.json",
        expected_type=list,
        item_required_keys=("reset_time", "source", "confidence", "notes"),
        max_items=2_000,
    ),
)


def fetch_json(source: Source, timeout: float = 20.0) -> Any:
    request = urllib.request.Request(
        source.url, headers={"User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError(f"{source.name}: response exceeds 8 MiB")
    return json.loads(body.decode("utf-8"))


def _require_string(
    value: Any,
    label: str,
    *,
    minimum: int = 1,
    maximum: int,
) -> str:
    if type(value) is not str or not minimum <= len(value) <= maximum:
        raise ValueError(
            f"{label}: expected string length {minimum}..{maximum}"
        )
    return value


def _parse_iso_datetime(value: Any, label: str) -> datetime:
    text = _require_string(value, label, maximum=64)
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"{label}: invalid ISO timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{label}: timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def _require_int(
    value: Any,
    label: str,
    *,
    minimum: int = 0,
    maximum: int = 10_000_000,
) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label}: expected integer {minimum}..{maximum}")
    return value


def _require_number(value: Any, label: str) -> float:
    if type(value) is int:
        return value
    if type(value) is float and math.isfinite(value):
        return value
    raise ValueError(f"{label}: expected a finite number")


def _require_probability(value: Any, label: str) -> float:
    number = _require_number(value, label)
    if not 0.0 <= number <= 1.0:
        raise ValueError(f"{label}: expected probability in range 0..1")
    return number


def _validate_prediction(prediction: Any, label: str) -> None:
    if type(prediction) is not dict:
        raise ValueError(f"{label}: expected dict")
    missing = [key for key in PREDICTION_HORIZONS if key not in prediction]
    if missing:
        raise ValueError(f"{label}: missing keys: {', '.join(missing)}")
    for horizon in PREDICTION_HORIZONS:
        _require_probability(prediction[horizon], f"{label}.{horizon}")


def _validate_prediction_document(payload: dict) -> None:
    _parse_iso_datetime(payload["updated_at"], "prediction.json.updated_at")
    _validate_prediction(payload["prediction"], "prediction.json.prediction")
    if "confidence" in payload:
        confidence = _require_string(
            payload["confidence"], "prediction.json.confidence", maximum=32
        )
        if confidence not in {"low", "medium", "high"}:
            raise ValueError("prediction.json.confidence: unexpected value")
    if "signals" in payload:
        signals = payload["signals"]
        if type(signals) is not dict or len(signals) > 200:
            raise ValueError("prediction.json.signals: expected a bounded dict")
    if "main_factors" in payload:
        factors = payload["main_factors"]
        if type(factors) is not list or len(factors) > 100:
            raise ValueError("prediction.json.main_factors: expected bounded list")
        for index, factor in enumerate(factors):
            if type(factor) is not dict:
                raise ValueError(
                    f"prediction.json.main_factors item {index}: expected dict"
                )
            if "factor" in factor:
                _require_string(
                    factor["factor"],
                    f"prediction.json.main_factors item {index}.factor",
                    maximum=500,
                )
    if "reasons" in payload:
        reasons = payload["reasons"]
        if type(reasons) is not list or len(reasons) > 100:
            raise ValueError("prediction.json.reasons: expected bounded list")
        for index, reason in enumerate(reasons):
            _require_string(
                reason,
                f"prediction.json.reasons item {index}",
                maximum=1_000,
            )


def _validate_prediction_history(payload: list) -> None:
    for index, item in enumerate(payload):
        label = f"prediction_history.json item {index}"
        _parse_iso_datetime(item["prediction_time"], f"{label}.prediction_time")
        _validate_prediction(item["prediction"], f"{label}.prediction")
        if "signals" in item and (
            type(item["signals"]) is not dict or len(item["signals"]) > 200
        ):
            raise ValueError(f"{label}.signals: expected a bounded dict")
        if "actual_result" in item and item["actual_result"] is not None:
            if type(item["actual_result"]) is not bool:
                raise ValueError(f"{label}.actual_result: expected bool or null")
        if "resolved_at" in item and item["resolved_at"] is not None:
            _parse_iso_datetime(item["resolved_at"], f"{label}.resolved_at")


def _normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def canonicalize_payload(source: Source, payload: Any) -> Any:
    if source.name != "tweets.json" or type(payload) is not list:
        return payload
    canonical: list[Any] = []
    for item in payload:
        if type(item) is not dict:
            canonical.append(item)
            continue
        excerpt = {}
        for field in TWEET_PUBLIC_FIELDS:
            value = item.get(field)
            if type(value) is str:
                value = _normalize_whitespace(value)
            if field == "text" and type(value) is str and len(value) > 360:
                value = value[:360].rstrip() + "…"
            excerpt[field] = value
        canonical.append(excerpt)
    return canonical


def _host_is(hostname: str, allowed_domain: str) -> bool:
    return hostname == allowed_domain or hostname.endswith("." + allowed_domain)


def _validate_https_url(value: Any, label: str) -> str:
    url = _require_string(value, label, maximum=2_048)
    if any(character.isspace() for character in url):
        raise ValueError(f"{label}: whitespace is not allowed")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise ValueError(f"{label}: invalid URL") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        raise ValueError(f"{label}: expected a public HTTPS URL")
    return parsed.hostname.lower()


def _validate_status_url_handle(value: str, label: str, allowed: set[str]) -> None:
    parsed = urlsplit(value)
    match = re.fullmatch(r"/([^/]+)/status/(\d+)/?", parsed.path, re.IGNORECASE)
    if match is None or match.group(1).lower() not in allowed:
        raise ValueError(f"{label}: unexpected status account or path")


def _validate_tweets(payload: list) -> None:
    expected_fields = set(TWEET_PUBLIC_FIELDS)
    future_limit = datetime.now(timezone.utc) + timedelta(hours=24)
    for index, item in enumerate(payload):
        label = f"tweets.json item {index}"
        if set(item) != expected_fields:
            raise ValueError(f"{label}: unexpected public fields")
        timestamp = _parse_iso_datetime(item["timestamp"], f"{label}.timestamp")
        if timestamp > future_limit:
            raise ValueError(f"{label}.timestamp: more than 24 hours in future")
        author = _require_string(item["author"], f"{label}.author", maximum=100)
        text = _require_string(item["text"], f"{label}.text", maximum=361)
        source_name = _require_string(
            item["source"], f"{label}.source", maximum=32
        )
        url = _require_string(item["url"], f"{label}.url", maximum=2_048)
        for field, value in (
            ("timestamp", item["timestamp"]),
            ("author", author),
            ("text", text),
            ("source", source_name),
            ("url", url),
        ):
            if value != _normalize_whitespace(value):
                raise ValueError(f"{label}.{field}: whitespace is not normalized")
        if len(text) == 361 and not text.endswith("…"):
            raise ValueError(f"{label}.text: oversized excerpt")
        hostname = _validate_https_url(url, f"{label}.url")
        _require_probability(item["authority_score"], f"{label}.authority_score")

        if source_name == "tibo_rss":
            if author not in TIBO_AUTHORS or not any(
                _host_is(hostname, domain) for domain in ("x.com", "twitter.com")
            ):
                raise ValueError(f"{label}: invalid tibo_rss author or url")
            _validate_status_url_handle(
                url,
                f"{label}.url",
                {"thsottiaux"},
            )
        elif source_name == "community_rss":
            if not _host_is(hostname, "reddit.com"):
                raise ValueError(f"{label}.url: community_rss requires reddit.com")
        elif source_name in OFFICIAL_TWEET_SOURCES:
            if author not in OFFICIAL_AUTHORS or not any(
                _host_is(hostname, domain)
                for domain in ("x.com", "twitter.com", "openai.com")
            ):
                raise ValueError(f"{label}: invalid official author or url")
            if any(
                _host_is(hostname, domain) for domain in ("x.com", "twitter.com")
            ):
                _validate_status_url_handle(
                    url,
                    f"{label}.url",
                    {"openai", "openaidevs", "chatgptapp"},
                )
        else:
            raise ValueError(f"{label}.source: source is not allowlisted")


def _validate_model_performance(payload: dict) -> None:
    total = _require_int(
        payload["total_predictions"], "model_performance.json.total_predictions"
    )
    resolved = _require_int(
        payload["resolved_predictions"],
        "model_performance.json.resolved_predictions",
    )
    if resolved > total:
        raise ValueError(
            "model_performance.json.resolved_predictions: exceeds total_predictions"
        )
    _require_probability(
        payload["overall_brier_score"],
        "model_performance.json.overall_brier_score",
    )
    _require_probability(
        payload["overall_accuracy"], "model_performance.json.overall_accuracy"
    )
    _parse_iso_datetime(payload["updated_at"], "model_performance.json.updated_at")

    horizons = payload["horizons"]
    if type(horizons) is not list or not 1 <= len(horizons) <= 24:
        raise ValueError("model_performance.json.horizons: expected list length 1..24")
    seen_hours: set[int] = set()
    for index, horizon in enumerate(horizons):
        label = f"model_performance.json.horizons item {index}"
        if type(horizon) is not dict:
            raise ValueError(f"{label}: expected dict")
        missing = [
            key
            for key in ("horizon_hours", "total", "brier_score", "accuracy")
            if key not in horizon
        ]
        if missing:
            raise ValueError(f"{label}: missing keys: {', '.join(missing)}")
        hours = _require_int(
            horizon["horizon_hours"], f"{label}.horizon_hours", minimum=1, maximum=8_760
        )
        if hours in seen_hours:
            raise ValueError(f"{label}.horizon_hours: duplicate value")
        seen_hours.add(hours)
        horizon_total = _require_int(horizon["total"], f"{label}.total")
        if horizon_total > total:
            raise ValueError(f"{label}.total: exceeds total_predictions")
        _require_probability(horizon["brier_score"], f"{label}.brier_score")
        _require_probability(horizon["accuracy"], f"{label}.accuracy")
        if "calibration_error" in horizon:
            _require_probability(
                horizon["calibration_error"], f"{label}.calibration_error"
            )
        if "bins" in horizon:
            bins = horizon["bins"]
            if type(bins) is not list or len(bins) > 100:
                raise ValueError(f"{label}.bins: expected bounded list")
            for bin_index, bin_value in enumerate(bins):
                bin_label = f"{label}.bins item {bin_index}"
                if type(bin_value) is not dict:
                    raise ValueError(f"{bin_label}: expected dict")
                missing_bin_keys = [
                    key
                    for key in (
                        "bin_start",
                        "bin_end",
                        "predicted_mean",
                        "actual_frequency",
                        "count",
                    )
                    if key not in bin_value
                ]
                if missing_bin_keys:
                    raise ValueError(
                        f"{bin_label}: missing keys: {', '.join(missing_bin_keys)}"
                    )
                start = _require_probability(
                    bin_value["bin_start"], f"{bin_label}.bin_start"
                )
                end = _require_probability(
                    bin_value["bin_end"], f"{bin_label}.bin_end"
                )
                if end < start:
                    raise ValueError(f"{bin_label}: bin_end precedes bin_start")
                _require_probability(
                    bin_value["predicted_mean"], f"{bin_label}.predicted_mean"
                )
                if bin_value["actual_frequency"] is not None:
                    _require_probability(
                        bin_value["actual_frequency"],
                        f"{bin_label}.actual_frequency",
                    )
                _require_int(bin_value["count"], f"{bin_label}.count")


def _validate_reset_history(payload: list) -> None:
    for index, item in enumerate(payload):
        label = f"reset_history.json item {index}"
        _parse_iso_datetime(item["reset_time"], f"{label}.reset_time")
        _require_string(item["source"], f"{label}.source", maximum=64)
        _require_probability(item["confidence"], f"{label}.confidence")
        _require_string(item["notes"], f"{label}.notes", maximum=500)


def validate_payload(source: Source, payload: Any) -> None:
    if type(payload) is not source.expected_type:
        raise ValueError(
            f"{source.name}: expected {source.expected_type.__name__}, "
            f"got {type(payload).__name__}"
        )

    if source.required_keys:
        missing_keys = [key for key in source.required_keys if key not in payload]
        if missing_keys:
            raise ValueError(
                f"{source.name}: missing required keys: {', '.join(missing_keys)}"
            )

    if source.expected_type is list:
        if source.max_items is not None and len(payload) > source.max_items:
            raise ValueError(
                f"{source.name}: expected at most {source.max_items} items"
            )
        for index, item in enumerate(payload):
            if type(item) is not dict:
                raise ValueError(
                    f"{source.name}: item {index} expected dict, "
                    f"got {type(item).__name__}"
                )
            missing_item_keys = [
                key for key in source.item_required_keys if key not in item
            ]
            if missing_item_keys:
                raise ValueError(
                    f"{source.name}: item {index} missing required keys: "
                    + ", ".join(missing_item_keys)
                )

    if source.name == "prediction.json":
        _validate_prediction_document(payload)
    elif source.name == "prediction_history.json":
        _validate_prediction_history(payload)
    elif source.name == "tweets.json":
        _validate_tweets(payload)
    elif source.name == "model_performance.json":
        _validate_model_performance(payload)
    elif source.name == "reset_history.json":
        _validate_reset_history(payload)


def atomic_write_json(path: Path, payload: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(payload, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _cache_is_valid(path: Path, source: Source) -> bool:
    try:
        with path.open("r", encoding="utf-8") as cache_file:
            payload = json.load(cache_file)
        validate_payload(source, payload)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return False
    return True


def _error_text(error: Exception) -> str:
    message = str(error).strip()
    if message:
        return f"{type(error).__name__}: {message}"
    return type(error).__name__


def sync_all(
    output_dir: str | Path,
    sources: tuple[Source, ...] = DEFAULT_SOURCES,
    timeout: float = 20.0,
) -> bool:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    source_statuses: list[dict[str, Any]] = []

    for source in sources:
        target = output_path / source.name
        try:
            payload = fetch_json(source, timeout)
            payload = canonicalize_payload(source, payload)
            validate_payload(source, payload)
            atomic_write_json(target, payload)
            source_statuses.append(
                {
                    "name": source.name,
                    "url": source.url,
                    "status": "fresh",
                    "error": None,
                }
            )
        except Exception as error:
            status = "cached" if _cache_is_valid(target, source) else "failed"
            source_statuses.append(
                {
                    "name": source.name,
                    "url": source.url,
                    "status": status,
                    "error": _error_text(error),
                }
            )

    statuses = {entry["status"] for entry in source_statuses}
    if "failed" in statuses:
        overall_status = "failed"
    elif "cached" in statuses:
        overall_status = "degraded"
    else:
        overall_status = "ok"

    status_payload = {
        "schema": 1,
        "synced_at": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "overall_status": overall_status,
        "sources": source_statuses,
    }
    atomic_write_json(output_path / "sync-status.json", status_payload)
    return "failed" not in statuses


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mirror the public Tibo Reset data")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--timeout", default=20.0, type=float)
    arguments = parser.parse_args(argv)

    succeeded = sync_all(arguments.output_dir, timeout=arguments.timeout)
    status_path = arguments.output_dir / "sync-status.json"
    with status_path.open("r", encoding="utf-8") as status_file:
        status_payload = json.load(status_file)
    counts = Counter(entry["status"] for entry in status_payload["sources"])
    print(
        f"sync {status_payload['overall_status']}: "
        f"fresh={counts['fresh']} cached={counts['cached']} "
        f"failed={counts['failed']}"
    )
    return 0 if succeeded else 1


if __name__ == "__main__":
    sys.exit(main())

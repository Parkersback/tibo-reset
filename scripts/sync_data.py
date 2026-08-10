import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
import urllib.request


USER_AGENT = "TiboResetMirror/1.0 (+https://github.com/Parkersback/tibo-reset)"
PREDICTION_HORIZONS = ("within_5h", "within_24h", "within_48h")


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    required_keys: tuple[str, ...] = ()
    expected_type: type[dict] | type[list] = dict


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
    ),
    Source(
        "tweets.json",
        "https://willtiboreset.xyz/data/tweets.json",
        expected_type=list,
    ),
    Source(
        "model_performance.json",
        "https://willtiboreset.xyz/data/model_performance.json",
        required_keys=("total_predictions", "horizons"),
    ),
    Source(
        "reset_history.json",
        "https://raw.githubusercontent.com/EvanProgramming/willtiboreset/main/data/reset_history.json",
        expected_type=list,
    ),
)


def fetch_json(source: Source, timeout: float = 20.0) -> Any:
    request = urllib.request.Request(
        source.url, headers={"User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


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

    if source.name == "prediction.json":
        prediction = payload.get("prediction")
        if type(prediction) is not dict:
            raise ValueError("prediction.json: prediction must be a dict")
        missing_horizons = [
            key for key in PREDICTION_HORIZONS if key not in prediction
        ]
        if missing_horizons:
            raise ValueError(
                "prediction.json: missing prediction keys: "
                + ", ".join(missing_horizons)
            )


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


def _cache_is_valid_json(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8") as cache_file:
            json.load(cache_file)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
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
            validate_payload(source, payload)
            atomic_write_json(target, payload)
            source_statuses.append(
                {"name": source.name, "url": source.url, "status": "fresh"}
            )
        except Exception as error:
            status = "cached" if _cache_is_valid_json(target) else "failed"
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

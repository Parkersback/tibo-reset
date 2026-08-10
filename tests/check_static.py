from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

REQUIRED_FILES = (
    "index.html",
    "styles.css",
    "app.js",
    "favicon.svg",
    "health.json",
)
REQUIRED_DATA_PATHS = (
    "data/prediction.json",
    "data/prediction_history.json",
    "data/tweets.json",
    "data/model_performance.json",
    "data/reset_history.json",
)
REQUIRED_SECTION_IDS = (
    "forecast",
    "factors",
    "signals",
    "history",
    "performance",
    "resets",
    "methodology",
)
REQUIRED_LANGUAGE_KEYS = (
    "zh-CN",
    "en",
)
REQUIRED_APP_TOKENS = (
    "tibo-reset-language",
    "./data/prediction.json",
    "./data/prediction_history.json",
    "./data/tweets.json",
    "./data/model_performance.json",
    "./data/reset_history.json",
)
EXPECTED_HEALTH = {"app": "tibo-reset", "status": "ok", "schema": 1}


class ElementIdParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.element_ids: set[str] = set()

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        for name, value in attrs:
            if name == "id" and value is not None:
                self.element_ids.add(value)


def read_utf8(path: Path, label: str, errors: list[str]) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        errors.append(f"invalid UTF-8 in {label}")
    except OSError as exc:
        errors.append(f"unable to read {label}: {exc}")
    return None


def load_json(path: Path, label: str, errors: list[str]) -> tuple[bool, Any]:
    text = read_utf8(path, label, errors)
    if text is None:
        return False, None
    try:
        return True, json.loads(text)
    except json.JSONDecodeError as exc:
        errors.append(
            f"invalid JSON in {label}: line {exc.lineno} column {exc.colno}"
        )
        return False, None


def has_quoted_js_key(source: str, key: str) -> bool:
    pattern = rf"(?P<quote>['\"]){re.escape(key)}(?P=quote)\s*:"
    return re.search(pattern, source) is not None


def matches_expected_health(value: Any) -> bool:
    if type(value) is not dict or value.keys() != EXPECTED_HEALTH.keys():
        return False
    return all(
        type(value[key]) is type(expected) and value[key] == expected
        for key, expected in EXPECTED_HEALTH.items()
    )


def main() -> int:
    errors: list[str] = []

    for relative_path in (*REQUIRED_FILES, *REQUIRED_DATA_PATHS):
        if not (SITE / relative_path).is_file():
            errors.append(f"missing required file: site/{relative_path}")

    html_path = SITE / "index.html"
    if html_path.is_file():
        html = read_utf8(html_path, "site/index.html", errors)
        if html is not None:
            parser = ElementIdParser()
            parser.feed(html)
            for section_id in REQUIRED_SECTION_IDS:
                if section_id not in parser.element_ids:
                    errors.append(
                        f"missing section id in site/index.html: {section_id}"
                    )

    app_path = SITE / "app.js"
    if app_path.is_file():
        app_js = read_utf8(app_path, "site/app.js", errors)
        if app_js is not None:
            for language_key in REQUIRED_LANGUAGE_KEYS:
                if not has_quoted_js_key(app_js, language_key):
                    errors.append(
                        f"missing language key in site/app.js: {language_key}"
                    )
            for token in REQUIRED_APP_TOKENS:
                if token not in app_js:
                    errors.append(f"missing token in site/app.js: {token}")

    health_path = SITE / "health.json"
    if health_path.is_file():
        loaded, health = load_json(health_path, "site/health.json", errors)
        if loaded and not matches_expected_health(health):
            errors.append("health object mismatch in site/health.json")

    for relative_path in REQUIRED_DATA_PATHS:
        data_path = SITE / relative_path
        if data_path.is_file():
            load_json(data_path, f"site/{relative_path}", errors)

    if errors:
        print("STATIC CONTRACT FAIL")
        for error in errors:
            print(f"- {error}")
        return 1

    print("STATIC CONTRACT PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

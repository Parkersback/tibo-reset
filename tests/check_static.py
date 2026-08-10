from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

REQUIRED_FILES = (
    "index.html",
    "styles.css",
    "app.js",
    "favicon.svg",
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
REQUIRED_APP_TOKENS = (
    "zh-CN",
    "en",
    "tibo-reset-language",
    "./data/prediction.json",
    "./data/prediction_history.json",
    "./data/tweets.json",
    "./data/model_performance.json",
    "./data/reset_history.json",
)


def main() -> int:
    errors: list[str] = []

    for relative_path in REQUIRED_FILES:
        if not (SITE / relative_path).is_file():
            errors.append(f"missing required file: site/{relative_path}")

    html_path = SITE / "index.html"
    if html_path.is_file():
        html = html_path.read_text(encoding="utf-8")
        for section_id in REQUIRED_SECTION_IDS:
            if f'id="{section_id}"' not in html and f"id='{section_id}'" not in html:
                errors.append(f"missing section id in site/index.html: {section_id}")

    app_path = SITE / "app.js"
    if app_path.is_file():
        app_js = app_path.read_text(encoding="utf-8")
        for token in REQUIRED_APP_TOKENS:
            if token not in app_js:
                errors.append(f"missing token in site/app.js: {token}")

    if errors:
        print("STATIC CONTRACT FAIL")
        for error in errors:
            print(f"- {error}")
        return 1

    print("STATIC CONTRACT PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

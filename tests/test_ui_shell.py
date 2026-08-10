from html.parser import HTMLParser
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

SECTION_ORDER = (
    "forecast",
    "factors",
    "signals",
    "history",
    "performance",
    "resets",
    "methodology",
)

REQUIRED_I18N_KEYS = {
    "status.unofficial",
    "status.loading",
    "header.updated",
    "nav.forecast",
    "nav.signals",
    "nav.history",
    "nav.methodology",
    "forecast.eyebrow",
    "forecast.title",
    "forecast.subtitle",
    "forecast.horizon5",
    "forecast.horizon24",
    "forecast.horizon48",
    "forecast.resetLabel",
    "forecast.countdownLabel",
    "forecast.actionLabel",
    "actions.notify",
    "actions.share",
    "actions.refresh",
    "actions.language",
    "factors.eyebrow",
    "factors.title",
    "signals.eyebrow",
    "signals.title",
    "history.eyebrow",
    "history.title",
    "history.chartTitle",
    "history.chartSummary",
    "performance.eyebrow",
    "performance.title",
    "performance.caution",
    "resets.eyebrow",
    "resets.title",
    "methodology.eyebrow",
    "methodology.title",
    "methodology.body",
    "methodology.disclaimer",
    "footer.note",
}


class ShellParser(HTMLParser):
    VOID_ELEMENTS = {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements: list[tuple[str, dict[str, str]]] = []
        self.section_ids: list[str] = []
        self.i18n_keys: set[str] = set()
        self._open_ids: list[str | None] = []
        self.text_by_id: dict[str, list[str]] = {}

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        values = {name: value or "" for name, value in attrs}
        self.elements.append((tag, values))
        element_id = values.get("id")
        if tag not in self.VOID_ELEMENTS:
            self._open_ids.append(element_id)
        if element_id:
            self.text_by_id.setdefault(element_id, [])
        if tag == "section" and element_id:
            self.section_ids.append(element_id)
        if values.get("data-i18n"):
            self.i18n_keys.add(values["data-i18n"])

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID_ELEMENTS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if self._open_ids:
            self._open_ids.pop()

    def handle_data(self, data: str) -> None:
        for element_id in self._open_ids:
            if element_id:
                self.text_by_id[element_id].append(data)

    def by_id(self, element_id: str) -> tuple[str, dict[str, str]]:
        matches = [item for item in self.elements if item[1].get("id") == element_id]
        if len(matches) != 1:
            raise AssertionError(
                f"expected exactly one #{element_id}, found {len(matches)}"
            )
        return matches[0]

    def text(self, element_id: str) -> str:
        return " ".join(self.text_by_id.get(element_id, [])).strip()


class ObservatoryShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = (SITE / "index.html").read_text(encoding="utf-8")
        cls.css = (SITE / "styles.css").read_text(encoding="utf-8")
        cls.favicon = (SITE / "favicon.svg").read_text(encoding="utf-8")
        cls.parser = ShellParser()
        cls.parser.feed(cls.html)

    def test_semantic_sections_follow_the_product_story(self) -> None:
        self.assertRegex(self.html, r'<html\b[^>]*\blang="zh-CN"')
        self.assertEqual(list(SECTION_ORDER), self.parser.section_ids)
        self.assertEqual("main", self.parser.by_id("main-content")[0])
        self.assertIn("<header", self.html)
        self.assertIn("<footer", self.html)

    def test_local_assets_only(self) -> None:
        stylesheet = [
            attrs
            for tag, attrs in self.parser.elements
            if tag == "link" and "stylesheet" in attrs.get("rel", "").split()
        ]
        favicon = [
            attrs
            for tag, attrs in self.parser.elements
            if tag == "link" and "icon" in attrs.get("rel", "").split()
        ]
        scripts = [attrs for tag, attrs in self.parser.elements if tag == "script"]
        self.assertEqual(["styles.css"], [attrs.get("href") for attrs in stylesheet])
        self.assertEqual(["favicon.svg"], [attrs.get("href") for attrs in favicon])
        self.assertEqual(["app.js"], [attrs.get("src") for attrs in scripts])
        self.assertTrue(scripts[0].get("defer") == "")

        external = re.compile(r"^(?:https?:)?//|^data:", re.IGNORECASE)
        resource_tags = {"link", "script", "img", "source", "video", "audio", "object", "embed"}
        for tag, attrs in self.parser.elements:
            if tag not in resource_tags:
                continue
            for attribute in ("src", "href", "data"):
                value = attrs.get(attribute, "")
                self.assertFalse(external.search(value), f"external resource: {value}")
        self.assertNotRegex(self.css, r"(?i)@import|url\(\s*['\"]?(?:https?:)?//")

    def test_all_core_labels_have_translation_hooks(self) -> None:
        missing = REQUIRED_I18N_KEYS - self.parser.i18n_keys
        self.assertFalse(missing, f"missing data-i18n hooks: {sorted(missing)}")
        self.assertEqual("Tibo Reset", self.parser.text("brand-name"))

    def test_forecast_shell_has_real_fallback_content(self) -> None:
        for horizon in ("5h", "24h", "48h"):
            card = self.parser.by_id(f"forecast-{horizon}")
            value = self.parser.by_id(f"probability-{horizon}")
            self.assertEqual(horizon, card[1].get("data-horizon"))
            self.assertRegex(
                self.parser.text(value[1]["id"]), r"(?:\d+|--)\s*%"
            )

        for element_id in (
            "next-reset-time",
            "countdown",
            "action-recommendation",
            "factors-list",
            "signals-list",
            "performance-metrics",
            "reset-timeline",
        ):
            self.assertTrue(
                self.parser.text(element_id),
                f"#{element_id} must not be empty before JavaScript loads",
            )

    def test_controls_are_native_buttons_with_accessible_names(self) -> None:
        for element_id in (
            "notification-button",
            "share-button",
            "refresh-button",
            "language-toggle",
        ):
            tag, attrs = self.parser.by_id(element_id)
            self.assertEqual("button", tag)
            self.assertEqual("button", attrs.get("type"))
            self.assertTrue(attrs.get("aria-label"))
            self.assertTrue(attrs.get("data-i18n-aria-label"))

        for element_id in ("data-status", "countdown", "action-feedback"):
            _, attrs = self.parser.by_id(element_id)
            self.assertEqual("polite", attrs.get("aria-live"))
            self.assertEqual("status", attrs.get("role"))

    def test_translatable_accessible_names_have_hooks(self) -> None:
        for tag, attrs in self.parser.elements:
            if "aria-label" in attrs:
                self.assertTrue(
                    attrs.get("data-i18n-aria-label"),
                    f"<{tag}> aria-label needs a translation hook",
                )

    def test_history_chart_has_a_programmatic_summary(self) -> None:
        tag, attrs = self.parser.by_id("history-chart")
        self.assertEqual("svg", tag)
        self.assertEqual("img", attrs.get("role"))
        self.assertEqual(
            "history-chart-title history-chart-summary",
            attrs.get("aria-labelledby"),
        )
        self.assertTrue(self.parser.text("history-chart-summary"))

    def test_css_defines_tokens_focus_motion_and_three_layout_modes(self) -> None:
        for token in (
            "--color-ink",
            "--color-coral",
            "--color-ice",
            "--color-amber",
            "--surface-glass",
            "--focus-ring",
            "--space-1",
            "--radius-card",
        ):
            self.assertIn(token, self.css)
        self.assertIn(":focus-visible", self.css)
        self.assertIn("prefers-reduced-motion", self.css)
        self.assertRegex(self.css, r"grid-template-columns:\s*repeat\(12,")
        for breakpoint in (1024, 760, 480):
            self.assertRegex(
                self.css,
                rf"@media\s*\(max-width:\s*{breakpoint}px\)",
            )

    def test_favicon_is_an_original_self_contained_radar_mark(self) -> None:
        root = ET.fromstring(self.favicon)
        namespace = {"svg": "http://www.w3.org/2000/svg"}
        self.assertTrue(root.tag.endswith("svg"))
        self.assertEqual("0 0 64 64", root.attrib.get("viewBox"))
        self.assertIsNotNone(root.find("svg:title", namespace))
        self.assertGreaterEqual(len(root.findall(".//svg:circle", namespace)), 2)
        self.assertIsNotNone(root.find(".//svg:linearGradient", namespace))
        self.assertIsNotNone(root.find(".//svg:path", namespace))
        self.assertNotRegex(
            self.favicon,
            r"(?i)(?:href|src)\s*=\s*['\"]https?://|url\(\s*['\"]?https?://|<image\b|<text\b",
        )


if __name__ == "__main__":
    unittest.main()

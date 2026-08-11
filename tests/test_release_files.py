from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
WORKFLOW = ROOT / ".github" / "workflows" / "pages.yml"
DEPENDABOT = ROOT / ".github" / "dependabot.yml"
NOJEKYLL = ROOT / "site" / ".nojekyll"
THIRD_PARTY_NOTICE = ROOT / "THIRD_PARTY_NOTICES.md"
DEPLOYED_NOTICE = ROOT / "site" / "NOTICE.txt"

SOURCE_URLS = (
    "https://willtiboreset.xyz/data/prediction.json",
    "https://willtiboreset.xyz/data/prediction_history.json",
    "https://willtiboreset.xyz/data/tweets.json",
    "https://willtiboreset.xyz/data/model_performance.json",
    "https://raw.githubusercontent.com/EvanProgramming/willtiboreset/main/data/reset_history.json",
)

ACTION_PINS = {
    "actions/checkout": ("3d3c42e5aac5ba805825da76410c181273ba90b1", "v7"),
    "actions/setup-python": ("5fda3b95a4ea91299a34e894583c3862153e4b97", "v7.0.0"),
    "actions/configure-pages": ("45bfe0192ca1faeb007ade9deae92b16b8254a0d", "v6"),
    "actions/upload-pages-artifact": ("fc324d3547104276b827a68afc52ff2a11cc49c9", "v5"),
    "actions/deploy-pages": ("cd2ce8fcbc39b97be8ca5fce6e763baed58fa128", "v5"),
}


class ReadmeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not README.is_file():
            raise AssertionError("README.md is required")
        cls.readme = README.read_text(encoding="utf-8")

    def test_product_boundary_and_disclaimer_are_explicit(self) -> None:
        for token in (
            "非官方",
            "额度重置预测站",
            "OpenAI",
            "Thibault Sottiaux",
            "无隶属或背书",
            "预测仅供娱乐和信息参考",
            "上游模型指标未独立验证",
            "额外全局 hard reset",
            "weekly reset",
            "banked reset",
            "boost/unlock",
            "不自研概率模型",
            "不使用 X API",
        ):
            self.assertIn(token, self.readme)

        self.assertRegex(self.readme, r"截图.{0,60}(?:已生成|Playwright)")

    def test_local_operation_and_direct_commands_are_documented(self) -> None:
        for token in (
            r"D:\桌面\Tibo-Reset",
            "启动 Tibo Reset.cmd",
            "-Port",
            "-NoBrowser",
            "python scripts/sync_data.py --output-dir site/data --timeout 20",
            "python -m http.server 4178 --bind 127.0.0.1 --directory site",
        ):
            self.assertIn(token, self.readme)

    def test_exact_five_public_sources_and_cache_fallback_are_documented(self) -> None:
        for source_url in SOURCE_URLS:
            self.assertIn(source_url, self.readme)
        for token in ("镜像", "原子替换", "缓存", "降级", "sync-status.json"):
            self.assertIn(token, self.readme)

    def test_features_notification_limits_tests_and_pages_schedule_are_documented(self) -> None:
        for token in (
            "5h / 24h / 48h",
            "预测因素",
            "当前信号",
            "概率历史",
            "模型表现",
            "历史重置",
            "中英双语",
            "浏览器通知",
            "HTTPS 或 localhost",
            "页面保持打开",
            "python -m unittest discover -s tests -p \"test_*.py\"",
            "python tests/check_static.py",
            "node --check site/app.js",
            "GitHub Pages",
            "7、27、47 分",
            "UTC",
            "长期无活动",
        ):
            self.assertIn(token, self.readme)

    def test_notice_and_upstream_license_boundary_are_linked(self) -> None:
        for token in (
            "[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)",
            "[site/NOTICE.txt](site/NOTICE.txt)",
            "无可核验的 LICENSE 文件",
            "不依赖上游代码许可",
        ):
            self.assertIn(token, self.readme)


class PagesWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not WORKFLOW.is_file():
            raise AssertionError(".github/workflows/pages.yml is required")
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_triggers_permissions_concurrency_and_single_job(self) -> None:
        self.assertRegex(self.workflow, r"(?m)^name:\s*.*Pages.*$")
        self.assertRegex(self.workflow, r"(?ms)^on:\s*\n\s{2}push:\s*\n\s{4}branches:\s*\n\s{6}-\s*main\s*$")
        self.assertRegex(self.workflow, r"(?m)^\s{2}workflow_dispatch:\s*$")
        self.assertRegex(self.workflow, r"(?m)^\s{2}schedule:\s*$")
        self.assertIn("cron: '7,27,47 * * * *'", self.workflow)
        self.assertNotRegex(self.workflow, r"(?mi)^\s*timezone\s*:")

        for permission in (
            "contents: read",
            "pages: write",
            "id-token: write",
        ):
            self.assertIn(permission, self.workflow)
        self.assertRegex(
            self.workflow,
            r"(?ms)^concurrency:\s*\n\s{2}group:\s*pages\s*\n\s{2}cancel-in-progress:\s*false\s*$",
        )
        jobs = self.workflow.split("\njobs:\n", 1)[1]
        self.assertEqual(["deploy"], re.findall(r"(?m)^  ([\w-]+):\s*$", jobs))

    def test_deploy_job_environment_and_immutable_action_pins(self) -> None:
        for token in (
            "runs-on: ubuntu-latest",
            "timeout-minutes:",
            "name: github-pages",
            "url: ${{ steps.deployment.outputs.page_url }}",
            "python-version: '3.13'",
            "path: ./site",
            "id: deployment",
            "persist-credentials: false",
        ):
            self.assertIn(token, self.workflow)

        for action, (sha, version) in ACTION_PINS.items():
            self.assertRegex(
                self.workflow,
                rf"(?m)^\s*uses:\s*{re.escape(action)}@{sha}\s+# {version}\s*$",
            )
        uses_refs = re.findall(r"(?m)^\s*uses:\s*([^\s#]+)", self.workflow)
        self.assertEqual(len(ACTION_PINS), len(uses_refs))
        for uses_ref in uses_refs:
            self.assertRegex(uses_ref, r"^[^@]+@[0-9a-f]{40}$")
        self.assertNotRegex(self.workflow, r"(?m)^\s*uses:\s*[^\s]+@v\d+")

    def test_fresh_gate_and_fast_tests_run_before_upload(self) -> None:
        required_steps = (
            "python scripts/sync_data.py --output-dir site/data --timeout 20",
            'Path("site/data/sync-status.json")',
            'status.get("overall_status") != "ok"',
            "raise SystemExit",
            "python -m unittest discover -s tests -p \"test_*.py\"",
            "python tests/check_static.py",
            "node --check site/app.js",
            "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
            "actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
        )
        positions = [self.workflow.index(token) for token in required_steps]
        self.assertEqual(sorted(positions), positions)
        self.assertNotIn("continue-on-error: true", self.workflow)

    def test_workflow_has_no_repository_write_or_push_path(self) -> None:
        for forbidden in (
            "contents: write",
            "actions: write",
            "packages: write",
            "pull-requests: write",
            "persist-credentials: true",
            "git push",
            "git commit",
            "secrets.",
            "api.x.com",
            "api.twitter.com",
        ):
            self.assertNotIn(forbidden, self.workflow)


class SupplyChainAndNoticeContractTests(unittest.TestCase):
    def test_dependabot_reviews_github_actions_weekly_only(self) -> None:
        self.assertTrue(DEPENDABOT.is_file(), ".github/dependabot.yml is required")
        dependabot = DEPENDABOT.read_text(encoding="utf-8")
        for token in (
            "version: 2",
            'package-ecosystem: "github-actions"',
            'directory: "/"',
            "interval: \"weekly\"",
        ):
            self.assertIn(token, dependabot)
        self.assertEqual(1, dependabot.count("package-ecosystem:"))

    def test_root_and_deployed_notices_cover_sources_rights_and_contact(self) -> None:
        self.assertTrue(THIRD_PARTY_NOTICE.is_file(), "root notice is required")
        self.assertTrue(DEPLOYED_NOTICE.is_file(), "deployed notice is required")
        for notice_path in (THIRD_PARTY_NOTICE, DEPLOYED_NOTICE):
            notice = notice_path.read_text(encoding="utf-8")
            for source_url in SOURCE_URLS:
                self.assertIn(source_url, notice)
            for token in (
                "归原作者或权利人",
                "不主张其权利",
                "不授予许可",
                "不超过 360 个字符",
                "直链",
                "预测解释",
                "未复制上游代码或视觉",
                "非官方",
                "无隶属或背书",
                "issue",
                "删除或更正",
            ):
                self.assertIn(token, notice)


class PagesArtifactContractTests(unittest.TestCase):
    def test_nojekyll_exists_and_is_empty(self) -> None:
        self.assertTrue(NOJEKYLL.is_file(), "site/.nojekyll is required")
        self.assertEqual(b"", NOJEKYLL.read_bytes())


if __name__ == "__main__":
    unittest.main()

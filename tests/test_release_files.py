from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
WORKFLOW = ROOT / ".github" / "workflows" / "pages.yml"
NOJEKYLL = ROOT / "site" / ".nojekyll"

SOURCE_URLS = (
    "https://willtiboreset.xyz/data/prediction.json",
    "https://willtiboreset.xyz/data/prediction_history.json",
    "https://willtiboreset.xyz/data/tweets.json",
    "https://willtiboreset.xyz/data/model_performance.json",
    "https://raw.githubusercontent.com/EvanProgramming/willtiboreset/main/data/reset_history.json",
)


class ReadmeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not README.is_file():
            raise AssertionError("README.md is required")
        cls.readme = README.read_text(encoding="utf-8")

    def test_product_boundary_and_disclaimer_are_explicit(self) -> None:
        for token in (
            "非官方",
            "额度重置预测仪表盘",
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

        self.assertRegex(self.readme, r"截图.{0,40}(?:尚未|待 Task 7)")

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

    def test_deploy_job_environment_timeout_and_action_versions(self) -> None:
        for token in (
            "runs-on: ubuntu-latest",
            "timeout-minutes:",
            "name: github-pages",
            "url: ${{ steps.deployment.outputs.page_url }}",
            "actions/checkout@v7",
            "actions/setup-python@v6",
            "python-version: '3.13'",
            "actions/configure-pages@v6",
            "actions/upload-pages-artifact@v5",
            "path: ./site",
            "actions/deploy-pages@v5",
            "id: deployment",
            "persist-credentials: false",
        ):
            self.assertIn(token, self.workflow)

    def test_sync_and_fast_tests_run_before_upload(self) -> None:
        required_steps = (
            "python scripts/sync_data.py --output-dir site/data --timeout 20",
            "python -m unittest discover -s tests -p \"test_*.py\"",
            "python tests/check_static.py",
            "node --check site/app.js",
            "actions/upload-pages-artifact@v5",
            "actions/deploy-pages@v5",
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


class PagesArtifactContractTests(unittest.TestCase):
    def test_nojekyll_exists_and_is_empty(self) -> None:
        self.assertTrue(NOJEKYLL.is_file(), "site/.nojekyll is required")
        self.assertEqual(b"", NOJEKYLL.read_bytes())


if __name__ == "__main__":
    unittest.main()

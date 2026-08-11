from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "worker.yml"
README = ROOT / "README.md"
EDGE_CONFIG = ROOT / "site" / "edge-config.json"
WRANGLER_CONFIG = ROOT / "worker" / "wrangler.jsonc"
PACKAGE = ROOT / "worker" / "package.json"


class EdgeReleaseContractTests(unittest.TestCase):
    def test_worker_workflow_is_guarded_and_uses_least_privilege(self) -> None:
        self.assertTrue(WORKFLOW.is_file(), "worker deployment workflow is required")
        workflow = WORKFLOW.read_text(encoding="utf-8")
        for token in (
            "workflow_dispatch:",
            "vars.CLOUDFLARE_WORKER_ENABLED == 'true'",
            "contents: read",
            "persist-credentials: false",
            "working-directory: worker",
            "npm ci",
            "npm test",
            "npm run check",
            "DATA_MIRROR requires a real 32-character KV namespace id",
            "npm run deploy",
            "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
            "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
        ):
            self.assertIn(token, workflow)
        for forbidden in (
            "contents: write",
            "id-token: write",
            "pull-requests: write",
            "persist-credentials: true",
        ):
            self.assertNotIn(forbidden, workflow)
        uses_refs = re.findall(r"(?m)^\s*uses:\s*([^\s#]+)", workflow)
        self.assertGreaterEqual(len(uses_refs), 2)
        for uses_ref in uses_refs:
            self.assertRegex(uses_ref, r"^[^@]+@[0-9a-f]{40}$")

    def test_runtime_config_uses_the_verified_worker_url(self) -> None:
        self.assertTrue(EDGE_CONFIG.is_file(), "edge runtime config is required")
        config = EDGE_CONFIG.read_text(encoding="utf-8")
        self.assertRegex(config, r'"edgeMode"\s*:\s*"(?:shadow|primary)"')
        self.assertIn(
            '"edgeSnapshotUrl": "https://tibo-reset-data-mirror.'
            'tibo-reset-data-worker.workers.dev/v1/bundle.json"',
            config,
        )
        self.assertNotIn("REPLACE_ME", config)

    def test_worker_declares_five_minute_cron_and_kv_binding(self) -> None:
        self.assertTrue(WRANGLER_CONFIG.is_file(), "wrangler config is required")
        config = WRANGLER_CONFIG.read_text(encoding="utf-8")
        for token in (
            '"workers_dev": true',
            '"crons": ["*/5 * * * *"]',
            '"binding": "DATA_MIRROR"',
            '"name": "REFRESH_COORDINATOR"',
            '"new_sqlite_classes": ["RefreshCoordinator"]',
        ):
            self.assertIn(token, config)

    def test_worker_package_is_locked_and_exposes_verification_commands(self) -> None:
        self.assertTrue(PACKAGE.is_file(), "worker package.json is required")
        package = PACKAGE.read_text(encoding="utf-8")
        for token in ('"test"', '"check"', '"wrangler"'):
            self.assertIn(token, package)
        self.assertTrue((ROOT / "worker" / "package-lock.json").is_file())

    def test_readme_explains_actual_latency_fallback_and_activation(self) -> None:
        readme = README.read_text(encoding="utf-8")
        for token in (
            "Cloudflare Worker",
            "Workers KV",
            "Durable Object",
            "每 5 分钟",
            "edgeMode",
            "off",
            "shadow",
            "primary",
            "Pages 兜底",
            "CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_ACCOUNT_ID",
            "npx wrangler login",
            "npx wrangler whoami",
            "wrangler kv namespace create DATA_MIRROR",
            "不承诺秒级实时",
        ):
            self.assertIn(token, readme)


if __name__ == "__main__":
    unittest.main()

from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DashboardControllerTests(unittest.TestCase):
    def test_node_controller_suite(self) -> None:
        result = subprocess.run(
            ["node", "--test", "tests/dashboard_controller.test.js"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        details = "\n".join(part for part in (result.stdout, result.stderr) if part)
        self.assertEqual(0, result.returncode, details)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "start-site.ps1"
CMD_LAUNCHER = ROOT / "启动 Tibo Reset.cmd"
POWERSHELL = Path(
    os.environ.get(
        "SystemRoot", "C:\\Windows"
    )
) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
PYTHON = (
    Path("C:/Python313/python.exe")
    if Path("C:/Python313/python.exe").is_file()
    else Path(sys.executable)
)
LAUNCH_CAPTURE_DIRECTORIES: list[Path] = []


def unused_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def invoke_launcher(port: int, *extra_args: str) -> subprocess.CompletedProcess[str]:
    command = [
        str(POWERSHELL),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(LAUNCHER),
        "-Port",
        str(port),
        "-NoBrowser",
        *extra_args,
    ]
    # A non-project cwd proves the launcher resolves every project path from
    # its own location, including when the repository path contains Chinese.
    # Windows PowerShell can let a detached child retain inherited pipe
    # handles even after powershell.exe exits. File-backed capture makes the
    # test wait for the launcher process itself, never for the healthy server.
    output_dir = Path(tempfile.mkdtemp(prefix="tibo-launcher-output-"))
    LAUNCH_CAPTURE_DIRECTORIES.append(output_dir)
    stdout_path = output_dir / "stdout.txt"
    stderr_path = output_dir / "stderr.txt"
    with stdout_path.open("wb") as stdout_file, stderr_path.open(
        "wb"
    ) as stderr_file:
        launched = subprocess.run(
            command,
            cwd=Path(os.environ.get("TEMP", str(ROOT.parent))),
            stdout=stdout_file,
            stderr=stderr_file,
            timeout=35,
            check=False,
        )
    encoding = sys.stdout.encoding or "utf-8"
    stdout = stdout_path.read_text(encoding=encoding, errors="replace")
    stderr = stderr_path.read_text(encoding=encoding, errors="replace")
    return subprocess.CompletedProcess(
        launched.args, launched.returncode, stdout, stderr
    )


def cleanup_launcher_capture_directories() -> None:
    while LAUNCH_CAPTURE_DIRECTORIES:
        directory = LAUNCH_CAPTURE_DIRECTORIES.pop()
        last_error: OSError | None = None
        for _attempt in range(20):
            try:
                shutil.rmtree(directory)
                last_error = None
                break
            except FileNotFoundError:
                last_error = None
                break
            except OSError as error:
                last_error = error
                time.sleep(0.1)
        if last_error is not None:
            raise AssertionError(
                f"could not remove launcher capture directory {directory}: "
                f"{last_error}"
            )


def wait_for_json(port: int, timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urlopen(
                f"http://127.0.0.1:{port}/health.json", timeout=0.75
            ) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:  # pragma: no branch - retains useful failure
            last_error = error
            time.sleep(0.1)
    raise AssertionError(f"health endpoint did not become ready: {last_error}")


def listener_pid(port: int) -> int:
    query = (
        "$connection = Get-NetTCPConnection -LocalAddress '127.0.0.1' "
        f"-LocalPort {port} -State Listen -ErrorAction Stop | Select-Object -First 1; "
        "if ($null -eq $connection) { exit 2 }; "
        "[Console]::Out.Write($connection.OwningProcess)"
    )
    result = subprocess.run(
        [str(POWERSHELL), "-NoProfile", "-Command", query],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"could not resolve listener for port {port}: {result.stderr}"
        )
    return int(result.stdout.strip())


def safely_stop_test_http_server(
    process_id: int, port: int, created_after: datetime
) -> None:
    """Stop only a recently-created, precisely identified test HTTP server."""

    threshold = created_after.astimezone(timezone.utc).isoformat()
    cleanup = rf"""
$ErrorActionPreference = 'Stop'
$targetProcessId = {process_id}
$createdAfter = [DateTime]::Parse('{threshold}').ToUniversalTime()
$ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $targetProcessId"
if ($null -eq $ownedProcess) {{ exit 0 }}
$commandLine = [string]$ownedProcess.CommandLine
$creationTime = ([DateTime]$ownedProcess.CreationDate).ToUniversalTime()
$isHttpServer = $commandLine -match '(?i)(^|\s)-m\s+http\.server(\s|$)'
$hasPort = $commandLine -match '(^|\s){port}(\s|$)'
$hasSiteDirectory = $commandLine -match '(?i)--directory\s+["'']?site["'']?(\s|$)'
$isRecent = $creationTime -ge $createdAfter
if (-not ($isHttpServer -and $hasPort -and $hasSiteDirectory -and $isRecent)) {{
    Write-Error "Refusing to stop unverified process $targetProcessId`: $commandLine"
    exit 3
}}
Stop-Process -Id $targetProcessId -Force -ErrorAction Stop
Wait-Process -Id $targetProcessId -Timeout 5 -ErrorAction SilentlyContinue
"""
    result = subprocess.run(
        [str(POWERSHELL), "-NoProfile", "-Command", cleanup],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=12,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"safe cleanup rejected process {process_id}: "
            f"{result.stdout}\n{result.stderr}"
        )


@unittest.skipUnless(os.name == "nt", "launcher is Windows-specific")
class LauncherContractTests(unittest.TestCase):
    def test_powershell_has_required_parameters_and_safety_contract(self) -> None:
        script = LAUNCHER.read_text(encoding="utf-8")

        self.assertRegex(
            script,
            re.compile(
                r"\[ValidateRange\(\s*1\s*,\s*65535\s*\)\]\s*"
                r"\[int\]\s*\$Port\s*=\s*4178",
                re.IGNORECASE,
            ),
        )
        self.assertRegex(script, r"(?i)\[switch\]\s*\$NoBrowser")
        self.assertRegex(script, r"(?i)DontShow\s*=\s*\$true")
        self.assertRegex(script, r"(?i)\[switch\]\s*\$SkipSync")
        self.assertIn("$PSScriptRoot", script)
        self.assertRegex(script, r"(?i)Split-Path")
        self.assertRegex(script, r"(?i)Join-Path")
        self.assertNotRegex(script, r"(?i)\$(?:PSScriptRoot|env:)??PWD\b")
        self.assertNotRegex(script, r"(?im)^\s*(?:Set|Push)-Location\b")
        self.assertNotRegex(script, r"(?i)\$PID\s*=")
        self.assertIn('http://127.0.0.1:$Port/health.json', script)
        self.assertRegex(script, r"(?i)app\s+-ceq\s+['\"]tibo-reset['\"]")
        self.assertRegex(script, r"(?i)status\s+-ceq\s+['\"]ok['\"]")
        self.assertRegex(script, r"(?i)schema")
        self.assertRegex(script, r"(?i)scripts[\\/]sync_data\.py")
        self.assertRegex(script, r"(?i)['\"]--output-dir['\"]")
        self.assertRegex(script, r"(?i)['\"]--timeout['\"]\s*,?\s*['\"]?20")
        self.assertRegex(script, r"(?i)Start-Process")
        self.assertRegex(script, r"(?i)-WindowStyle\s+Hidden")
        self.assertRegex(script, r"(?i)-PassThru")
        self.assertRegex(script, r"(?i)-RedirectStandardOutput")
        self.assertRegex(script, r"(?i)-RedirectStandardError")
        self.assertRegex(script, r"(?i)['\"]-u['\"]")
        self.assertRegex(script, r"(?i)['\"]-m['\"]\s*,?\s*['\"]http\.server")
        self.assertRegex(script, r"(?i)['\"]--bind['\"]\s*,?\s*['\"]127\.0\.0\.1")
        self.assertRegex(script, r"(?i)['\"]--directory['\"]\s*,?\s*['\"]site['\"]")

    def test_powershell_parser_accepts_launcher(self) -> None:
        escaped_path = str(LAUNCHER).replace("'", "''")
        parser_check = rf"""
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    '{escaped_path}', [ref]$tokens, [ref]$errors
)
if ($errors.Count -gt 0) {{
    $errors | ForEach-Object {{ Write-Error $_.Message }}
    exit 1
}}
"""
        result = subprocess.run(
            [str(POWERSHELL), "-NoProfile", "-Command", parser_check],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=10,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)

    def test_python_candidate_rejects_39_and_accepts_310(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tibo-python-version-") as temp:
            temp_root = Path(temp)
            fake_candidates: dict[str, Path] = {}
            for label, minor in (("python39", 9), ("python310", 10)):
                candidate = temp_root / f"{label}.cmd"
                payload = json.dumps(
                    {
                        "ok": True,
                        "major": 3,
                        "minor": minor,
                        "executable": str(PYTHON),
                    }
                )
                candidate.write_text(
                    f"@echo off\r\necho {payload}\r\nexit /b 0\r\n",
                    encoding="ascii",
                )
                fake_candidates[label] = candidate

            def ps_literal(path: Path) -> str:
                return str(path).replace("'", "''")

            probe_script = temp_root / "probe-version.ps1"
            probe_script.write_text(
                rf"""
$tokens = $null
$parseErrors = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile(
    '{ps_literal(LAUNCHER)}', [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {{ throw $parseErrors[0].Message }}
$candidateFunction = $launcherAst.Find({{
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Test-PythonCandidate'
}}, $true)
if ($null -eq $candidateFunction) {{
    throw 'Test-PythonCandidate function not found'
}}
Invoke-Expression $candidateFunction.Extent.Text
$python39 = Test-PythonCandidate -FilePath '{ps_literal(fake_candidates["python39"])}'
$python310 = Test-PythonCandidate -FilePath '{ps_literal(fake_candidates["python310"])}'
[pscustomobject]@{{
    rejected39 = $null -eq $python39
    accepted310 = $null -ne $python310
    acceptedMajor = $python310.VersionMajor
    acceptedMinor = $python310.VersionMinor
}} | ConvertTo-Json -Compress
""",
                encoding="utf-8-sig",
            )
            result = subprocess.run(
                [
                    str(POWERSHELL),
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(probe_script),
                ],
                capture_output=True,
                text=True,
                errors="replace",
                timeout=10,
                check=False,
            )

        self.assertEqual(0, result.returncode, result.stderr)
        observed = json.loads(result.stdout.strip())
        self.assertTrue(observed["rejected39"])
        self.assertTrue(observed["accepted310"])
        self.assertEqual(3, observed["acceptedMajor"])
        self.assertEqual(10, observed["acceptedMinor"])

    def test_python_requirement_is_clear_in_launcher_and_readme(self) -> None:
        script = LAUNCHER.read_text(encoding="utf-8")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("Python 3.10+", script)
        self.assertIn("Python 3.10+", readme)

    def test_cmd_wrapper_forwards_arguments_and_pauses_only_on_failure(self) -> None:
        wrapper = CMD_LAUNCHER.read_text(encoding="utf-8-sig")

        self.assertIn("%~dp0scripts\\start-site.ps1", wrapper)
        self.assertRegex(wrapper, r"(?i)powershell(?:\.exe)?\s+-NoProfile")
        self.assertRegex(wrapper, r"(?i)-ExecutionPolicy\s+Bypass")
        self.assertIn("%*", wrapper)
        self.assertRegex(wrapper, r"(?i)if\s+not\s+.*(?:errorlevel|exitCode)")
        self.assertRegex(wrapper, r"(?is)if\s+not\s+.*?\(.*?pause.*?\)")
        self.assertRegex(wrapper, r"(?i)exit\s+/b")


@unittest.skipUnless(os.name == "nt", "launcher is Windows-specific")
class LauncherIntegrationTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        cleanup_launcher_capture_directories()

    def test_cold_start_then_reuse_preserves_listener_and_pid(self) -> None:
        while True:
            port = unused_tcp_port()
            runtime_paths = (
                ROOT / ".runtime" / f"server-{port}.pid",
                ROOT / ".runtime" / f"server-{port}.stdout.log",
                ROOT / ".runtime" / f"server-{port}.stderr.log",
            )
            if not any(path.exists() for path in runtime_paths):
                break
        created_after = datetime.now(timezone.utc) - timedelta(seconds=1)
        pid_path, stdout_path, stderr_path = runtime_paths
        process_id: int | None = None

        try:
            first = invoke_launcher(port, "-SkipSync")
            self.assertEqual(
                0,
                first.returncode,
                f"stdout:\n{first.stdout}\nstderr:\n{first.stderr}",
            )
            self.assertEqual(
                {"app": "tibo-reset", "status": "ok", "schema": 1},
                wait_for_json(port),
            )
            self.assertTrue(pid_path.is_file())
            self.assertTrue(stdout_path.is_file())
            self.assertTrue(stderr_path.is_file())
            process_id = int(pid_path.read_text(encoding="ascii").strip())
            first_listener = listener_pid(port)
            self.assertEqual(process_id, first_listener)

            second = invoke_launcher(port, "-SkipSync")
            self.assertEqual(
                0,
                second.returncode,
                f"stdout:\n{second.stdout}\nstderr:\n{second.stderr}",
            )
            self.assertIn("reuse", (second.stdout + second.stderr).lower())
            self.assertEqual(
                process_id, int(pid_path.read_text(encoding="ascii").strip())
            )
            self.assertEqual(first_listener, listener_pid(port))
        finally:
            cleanup_process_id = process_id
            if cleanup_process_id is None and pid_path.is_file():
                cleanup_process_id = int(
                    pid_path.read_text(encoding="ascii").strip()
                )
            if cleanup_process_id is not None:
                safely_stop_test_http_server(
                    cleanup_process_id, port, created_after
                )
            for runtime_path in runtime_paths:
                runtime_path.unlink(missing_ok=True)

    def test_wrong_site_on_port_fails_without_stopping_occupant(self) -> None:
        port = unused_tcp_port()
        created_after = datetime.now(timezone.utc) - timedelta(seconds=1)

        with tempfile.TemporaryDirectory(prefix="tibo-launcher-wrong-site-") as temp:
            temp_root = Path(temp)
            wrong_site = temp_root / "site"
            wrong_site.mkdir()
            (wrong_site / "health.json").write_text(
                '{"app":"tibo-reset","status":"ok","schema":"1"}\n',
                encoding="utf-8",
            )
            stdout_log = (temp_root / "stdout.log").open("wb")
            stderr_log = (temp_root / "stderr.log").open("wb")
            occupant = subprocess.Popen(
                [
                    str(PYTHON),
                    "-u",
                    "-m",
                    "http.server",
                    str(port),
                    "--bind",
                    "127.0.0.1",
                    "--directory",
                    "site",
                ],
                cwd=temp_root,
                stdout=stdout_log,
                stderr=stderr_log,
            )
            try:
                self.assertEqual(
                    "1", wait_for_json(port)["schema"]
                )

                launched = invoke_launcher(port, "-SkipSync")

                self.assertNotEqual(0, launched.returncode)
                combined = (launched.stdout + launched.stderr).lower()
                self.assertRegex(combined, r"occupied|占用")
                self.assertIsNone(
                    occupant.poll(), "launcher terminated the foreign occupant"
                )
                self.assertEqual(
                    "1", wait_for_json(port)["schema"]
                )
            finally:
                safely_stop_test_http_server(
                    occupant.pid, port, created_after
                )
                occupant.wait(timeout=5)
                stdout_log.close()
                stderr_log.close()


if __name__ == "__main__":
    unittest.main()

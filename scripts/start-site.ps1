[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4178,

    [switch]$NoBrowser,

    [Parameter(DontShow = $true)]
    [switch]$SkipSync
)

$ErrorActionPreference = 'Stop'

$scriptDirectory = $PSScriptRoot
$projectRoot = Split-Path -Parent $scriptDirectory
$syncScriptPath = Join-Path $projectRoot 'scripts\sync_data.py'
$siteDirectoryPath = Join-Path $projectRoot 'site'
$dataDirectoryPath = Join-Path $siteDirectoryPath 'data'
$runtimeDirectoryPath = Join-Path $projectRoot '.runtime'
$healthUrl = "http://127.0.0.1:$Port/health.json"
$siteUrl = "http://127.0.0.1:$Port/"
$pidFilePath = Join-Path $runtimeDirectoryPath "server-$Port.pid"
$stdoutLogPath = Join-Path $runtimeDirectoryPath "server-$Port.stdout.log"
$stderrLogPath = Join-Path $runtimeDirectoryPath "server-$Port.stderr.log"

function Test-TiboResetHealth {
    param([string]$Uri)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
        $health = $response.Content | ConvertFrom-Json
        if ($null -eq $health -or $null -eq $health.schema) {
            return $false
        }

        $numericSchemaTypes = @(
            [byte], [sbyte], [int16], [uint16], [int32], [uint32],
            [int64], [uint64], [single], [double], [decimal]
        )
        $schemaIsNumber = $numericSchemaTypes -contains $health.schema.GetType()

        return (
            ($health.app -ceq 'tibo-reset') -and
            ($health.status -ceq 'ok') -and
            $schemaIsNumber -and
            ([decimal]$health.schema -eq 1)
        )
    }
    catch {
        return $false
    }
}

function Test-LocalTcpPort {
    param(
        [int]$TargetPort,
        [int]$TimeoutMilliseconds = 600
    )

    $tcpClient = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $null
    try {
        $asyncResult = $tcpClient.BeginConnect(
            '127.0.0.1', $TargetPort, $null, $null
        )
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) {
            return $false
        }
        $tcpClient.EndConnect($asyncResult)
        return $tcpClient.Connected
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $asyncResult) {
            $asyncResult.AsyncWaitHandle.Close()
        }
        $tcpClient.Close()
    }
}

function Get-ListenerDescription {
    param([int]$TargetPort)

    try {
        $connectionCommand = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
        if ($null -ne $connectionCommand) {
            $connection = Get-NetTCPConnection `
                -LocalPort $TargetPort `
                -State Listen `
                -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.LocalAddress -eq '127.0.0.1' -or
                    $_.LocalAddress -eq '0.0.0.0' -or
                    $_.LocalAddress -eq '::'
                } |
                Select-Object -First 1
            if ($null -ne $connection) {
                $listenerProcessId = [int]$connection.OwningProcess
                $listenerProcess = Get-Process `
                    -Id $listenerProcessId `
                    -ErrorAction SilentlyContinue
                if ($null -ne $listenerProcess) {
                    return "PID $listenerProcessId ($($listenerProcess.ProcessName))"
                }
                return "PID $listenerProcessId"
            }
        }
    }
    catch {
        # Occupancy is already proven by TCP; process details are best effort.
    }
    return 'PID/process name unavailable'
}

function Throw-PortOccupied {
    param([int]$TargetPort)

    $listenerDescription = Get-ListenerDescription -TargetPort $TargetPort
    throw (
        "Port $TargetPort is occupied by another or invalid site " +
        "($listenerDescription). The launcher will not stop that process."
    )
}

function Test-PythonCandidate {
    param(
        [string]$FilePath,
        [string[]]$PrefixArguments = @()
    )

    try {
        $probeCode = (
            "import json,sys; print(json.dumps({" +
            "'ok': True, 'major': sys.version_info[0], " +
            "'minor': sys.version_info[1], " +
            "'executable': sys.executable}))"
        )
        $probeOutput = & $FilePath @PrefixArguments '-c' $probeCode 2>$null
        $probeExitCode = $LASTEXITCODE
        if ($probeExitCode -ne 0) {
            return $null
        }

        $probeLine = @($probeOutput) | Select-Object -Last 1
        $probe = $probeLine | ConvertFrom-Json
        $resolvedExecutable = [string]$probe.executable
        $versionMajor = [int]$probe.major
        $versionMinor = [int]$probe.minor
        $versionIsCompatible = (
            ($versionMajor -gt 3) -or
            ($versionMajor -eq 3 -and $versionMinor -ge 10)
        )
        if (
            $probe.ok -eq $true -and
            $versionIsCompatible -and
            -not [string]::IsNullOrWhiteSpace($resolvedExecutable) -and
            (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)
        ) {
            return [pscustomobject]@{
                FilePath = $resolvedExecutable
                VersionMajor = $versionMajor
                VersionMinor = $versionMinor
            }
        }
    }
    catch {
        return $null
    }
    return $null
}

function Find-VerifiedPython {
    $candidatePaths = New-Object System.Collections.Generic.List[string]
    $knownPython = 'C:\Python313\python.exe'
    if (Test-Path -LiteralPath $knownPython -PathType Leaf) {
        $candidatePaths.Add($knownPython)
    }

    $pythonCommand = Get-Command python -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $pythonCommand -and $pythonCommand.Source) {
        $candidatePaths.Add([string]$pythonCommand.Source)
    }

    foreach ($candidatePath in ($candidatePaths | Select-Object -Unique)) {
        $verified = Test-PythonCandidate -FilePath $candidatePath
        if ($null -ne $verified) {
            return $verified
        }
    }

    $pyCommand = Get-Command py -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $pyCommand -and $pyCommand.Source) {
        $verified = Test-PythonCandidate `
            -FilePath ([string]$pyCommand.Source) `
            -PrefixArguments @('-3')
        if ($null -ne $verified) {
            return $verified
        }
    }

    throw (
        'A working Python 3.10+ interpreter was not found. Checked ' +
        'C:\Python313\python.exe, the python command, and py -3.'
    )
}

function Open-TiboResetSite {
    if (-not $NoBrowser) {
        Start-Process -FilePath $siteUrl | Out-Null
    }
}

if (Test-TiboResetHealth -Uri $healthUrl) {
    Write-Output "[reuse] Existing verified Tibo Reset server: $siteUrl"
    Open-TiboResetSite
    exit 0
}

if (Test-LocalTcpPort -TargetPort $Port) {
    Throw-PortOccupied -TargetPort $Port
}

$python = Find-VerifiedPython

if (-not (Test-Path -LiteralPath $syncScriptPath -PathType Leaf)) {
    throw "Synchronizer not found: $syncScriptPath"
}
if (-not (Test-Path -LiteralPath $siteDirectoryPath -PathType Container)) {
    throw "Site directory not found: $siteDirectoryPath"
}

if ($SkipSync) {
    Write-Output '[test] Data synchronization skipped.'
}
else {
    Write-Output 'Synchronizing mirrored public data...'
    $syncArguments = @(
        $syncScriptPath,
        '--output-dir', $dataDirectoryPath,
        '--timeout', '20'
    )
    & $python.FilePath @syncArguments
    $syncExitCode = $LASTEXITCODE
    if ($syncExitCode -ne 0) {
        throw (
            "Data synchronization failed with exit code $syncExitCode. " +
            'The local server was not started.'
        )
    }
}

# Synchronization can take time, so protect against a port race before launch.
if (Test-LocalTcpPort -TargetPort $Port) {
    Throw-PortOccupied -TargetPort $Port
}

New-Item `
    -ItemType Directory `
    -Path $runtimeDirectoryPath `
    -Force |
    Out-Null

$serverArguments = @(
    '-u',
    '-m', 'http.server',
    [string]$Port,
    '--bind', '127.0.0.1',
    '--directory', 'site'
)

Write-Output "Starting verified local server on $siteUrl"
$serverProcess = Start-Process `
    -FilePath $python.FilePath `
    -ArgumentList $serverArguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $stdoutLogPath `
    -RedirectStandardError $stderrLogPath

$serverProcessId = [int]$serverProcess.Id
Set-Content `
    -LiteralPath $pidFilePath `
    -Value $serverProcessId `
    -Encoding ASCII

$startupDeadline = [DateTime]::UtcNow.AddSeconds(20)
$startupFailure = $null
$healthConfirmed = $false

while ([DateTime]::UtcNow -lt $startupDeadline) {
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
        $startupFailure = (
            "Server process $serverProcessId exited early with code " +
            "$($serverProcess.ExitCode)."
        )
        break
    }

    if (Test-TiboResetHealth -Uri $healthUrl) {
        $healthConfirmed = $true
        break
    }

    Start-Sleep -Milliseconds 300
}

if (-not $healthConfirmed) {
    if ($null -eq $startupFailure) {
        $startupFailure = (
            "Timed out after 20 seconds waiting for the exact Tibo Reset " +
            "health identity at $healthUrl."
        )
    }

    $serverProcess.Refresh()
    if (-not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $serverProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }

    $stderrTail = ''
    if (Test-Path -LiteralPath $stderrLogPath -PathType Leaf) {
        $stderrTail = (
            Get-Content -LiteralPath $stderrLogPath -Tail 20 -ErrorAction SilentlyContinue
        ) -join [Environment]::NewLine
    }

    Remove-Item -LiteralPath $pidFilePath -Force -ErrorAction SilentlyContinue
    if (-not [string]::IsNullOrWhiteSpace($stderrTail)) {
        throw "$startupFailure`nServer stderr tail:`n$stderrTail"
    }
    throw $startupFailure
}

Write-Output "[ready] Tibo Reset is healthy at $siteUrl (PID $serverProcessId)."
Open-TiboResetSite
exit 0

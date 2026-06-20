param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir = Join-Path $RepoRoot ".venv-build"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$TemplatesDir = Join-Path $RepoRoot "templates"
$StaticDir = Join-Path $RepoRoot "static"
$IconPath = Join-Path $RepoRoot "assets\specterew.ico"

Set-Location $RepoRoot

function Invoke-Native {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

function Invoke-HostPython {
    param([string[]]$Arguments)

    if ($env:PYTHON) {
        Invoke-Native $env:PYTHON $Arguments
        return
    }

    if (Get-Command py -ErrorAction SilentlyContinue) {
        Invoke-Native "py" (@("-3.12") + $Arguments)
        return
    }

    if (Get-Command python -ErrorAction SilentlyContinue) {
        Invoke-Native "python" $Arguments
        return
    }

    throw "Python 3.12 was not found. Install Python 3.12, or set the PYTHON environment variable to python.exe."
}

function Test-BuildVenv {
    if (-not (Test-Path $VenvPython)) {
        return $false
    }

    try {
        & $VenvPython --version *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

if (-not (Test-BuildVenv)) {
    if (Test-Path $VenvDir) {
        Write-Host "Existing .venv-build is not runnable; recreating it."
        Remove-Item -Recurse -Force $VenvDir
    }
    Invoke-HostPython @("-m", "venv", $VenvDir)
}
Invoke-Native $VenvPython @("--version")

if (-not $SkipInstall) {
    Invoke-Native $VenvPython @("-m", "pip", "install", "--upgrade", "pip")
    Invoke-Native $VenvPython @("-m", "pip", "install", "-r", "requirements.txt")
    Invoke-Native $VenvPython @("-m", "pip", "install", "-r", "requirements-build.txt")
}

Invoke-Native $VenvPython @("-m", "unittest")

$CommonPyInstallerArgs = @(
    "--noconfirm",
    "--clean",
    "--noupx",
    "--specpath", "build\onedir-spec",
    "--name", "SpecterEW",
    "--add-data", "${TemplatesDir};templates",
    "--add-data", "${StaticDir};static",
    "--icon", $IconPath,
    "--collect-all", "rasterio",
    "--collect-all", "shapely",
    "--collect-all", "PIL",
    "--collect-all", "certifi"
)

Invoke-Native $VenvPython (@("-m", "PyInstaller") + $CommonPyInstallerArgs + @("--onedir", "app.py"))

$OnedirExe = Join-Path $RepoRoot "dist\SpecterEW\SpecterEW.exe"
if (-not (Test-Path $OnedirExe)) {
    throw "Onedir validation build did not produce $OnedirExe"
}
Invoke-Native $VenvPython @("tools\smoke_test_executable.py", $OnedirExe)

Invoke-Native $VenvPython @("-m", "PyInstaller", "--noconfirm", "--clean", "SpecterEW.spec")

$OnefileExe = Join-Path $RepoRoot "dist\SpecterEW.exe"
if (-not (Test-Path $OnefileExe)) {
    throw "Onefile build did not produce $OnefileExe"
}
Invoke-Native $VenvPython @("tools\smoke_test_executable.py", $OnefileExe)

Write-Host ""
Write-Host "Built validation bundle: $OnedirExe"
Write-Host "Built single-file executable: $OnefileExe"
Write-Host "Run it, then open http://localhost:5000 in a browser."

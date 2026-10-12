# Exercise the real upgrade hook in isolated install directories. Never closes or upgrades the app.
param([string]$Compiler = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe")
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Compiler)) { throw "NSIS compiler not found: $Compiler" }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$testRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target\agent-cleanup-test-$([guid]::NewGuid().ToString('N'))"))
if (-not $testRoot.StartsWith("$repoRoot\target\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected cleanup test path'
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
$template = @'
Unicode true
Name "widgetsack cleanup test"
OutFile "@OUTPUT@"
RequestExecutionLevel user
SilentInstall silent
!include "@HOOKS@"
Section
StrCpy $INSTDIR "@FIXTURE@"
!insertmacro _WS_REMOVE_LEGACY_AGENT
SectionEnd
'@
foreach ($scenario in @('upgrade', 'unrelated')) {
    $fixture = Join-Path $testRoot $scenario
    $dependency = Join-Path $fixture 'studio-agent\node_modules\example'
    New-Item -ItemType Directory -Path $dependency -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $dependency 'index.js') -Value 'old dependency'
    Set-Content -LiteralPath (Join-Path $fixture 'studio-agent\node.exe') -Value 'old runtime'
    Set-Content -LiteralPath (Join-Path $fixture 'widgets.json') -Value 'preserve layouts'
    if ($scenario -eq 'upgrade') {
        Set-Content -LiteralPath (Join-Path $fixture 'widgetsack.exe') -Value 'new app marker'
    }
    $output = Join-Path $testRoot "$scenario.exe"
    $script = Join-Path $testRoot "$scenario.nsi"
    $text = $template.Replace('@OUTPUT@', $output.Replace('$', '$$')).Replace('@FIXTURE@', $fixture.Replace('$', '$$')).Replace('@HOOKS@', (Join-Path $PSScriptRoot 'hooks.nsh').Replace('$', '$$'))
    Set-Content -LiteralPath $script -Value $text -Encoding utf8
    & $Compiler /V2 $script
    if ($LASTEXITCODE -ne 0) { throw "NSIS fixture compilation failed: $scenario" }
    $run = Start-Process -FilePath $output -Wait -PassThru -WindowStyle Hidden
    if ($run.ExitCode -ne 0) { throw "NSIS cleanup failed: $scenario" }
    if ((Get-Content -LiteralPath (Join-Path $fixture 'widgets.json') -Raw).Trim() -ne 'preserve layouts') {
        throw 'Cleanup changed a layout file'
    }
    $legacyExists = Test-Path -LiteralPath (Join-Path $fixture 'studio-agent')
    if (($scenario -eq 'upgrade' -and $legacyExists) -or ($scenario -eq 'unrelated' -and -not $legacyExists)) {
        throw "Unexpected cleanup result: $scenario"
    }
}
Write-Output 'Upgrade cleanup passed: old Node and node_modules removed; layouts and unrelated directories preserved.'

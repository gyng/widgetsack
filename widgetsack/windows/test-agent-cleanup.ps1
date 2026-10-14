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
Var PassiveMode
!include "@HOOKS@"
!insertmacro _WS_DEFINE_REMOVE_TREE ""
Section
StrCpy $INSTDIR "@FIXTURE@"
StrCpy $PassiveMode 0
!insertmacro _WS_REMOVE_LEGACY_AGENT ""
SectionEnd
'@
foreach ($scenario in @('upgrade', 'unrelated', 'linked-root', 'linked-child', 'ambiguous-name', 'readonly')) {
    $fixture = Join-Path $testRoot $scenario
    New-Item -ItemType Directory -Path $fixture | Out-Null
    $outside = Join-Path $testRoot "$scenario-external"
    New-Item -ItemType Directory -Path $outside | Out-Null
    Set-Content -LiteralPath (Join-Path $outside 'keep.txt') -Value 'preserve external files'
    if ($scenario -eq 'linked-root') {
        New-Item -ItemType Junction -Path (Join-Path $fixture 'studio-agent') -Target $outside | Out-Null
    }
    $dependency = Join-Path $fixture 'studio-agent\node_modules\example'
    New-Item -ItemType Directory -Path $dependency -Force | Out-Null
    if ($scenario -eq 'ambiguous-name') {
        [IO.Directory]::CreateDirectory("\\?\$dependency\. ") | Out-Null
    }
    Set-Content -LiteralPath (Join-Path $dependency 'index.js') -Value 'old dependency'
    if ($scenario -eq 'readonly') {
        [IO.File]::SetAttributes((Join-Path $dependency 'index.js'), [IO.FileAttributes]::ReadOnly)
    }
    Set-Content -LiteralPath (Join-Path $fixture 'studio-agent\node.exe') -Value 'old runtime'
    Set-Content -LiteralPath (Join-Path $fixture 'widgets.json') -Value 'preserve layouts'
    if ($scenario -eq 'linked-child') {
        New-Item -ItemType Junction -Path (Join-Path $dependency 'external') -Target $outside | Out-Null
    }
    if ($scenario -ne 'unrelated') {
        Set-Content -LiteralPath (Join-Path $fixture 'widgetsack.exe') -Value 'new app marker'
    }
    $output = Join-Path $testRoot "$scenario.exe"
    $script = Join-Path $testRoot "$scenario.nsi"
    $text = $template.Replace('@OUTPUT@', $output.Replace('$', '$$')).Replace('@FIXTURE@', $fixture.Replace('$', '$$')).Replace('@HOOKS@', (Join-Path $PSScriptRoot 'hooks.nsh').Replace('$', '$$'))
    Set-Content -LiteralPath $script -Value $text -Encoding utf8
    & $Compiler /INPUTCHARSET UTF8 /V2 $script
    if ($LASTEXITCODE -ne 0) { throw "NSIS fixture compilation failed: $scenario" }
    $run = Start-Process -FilePath $output -PassThru -WindowStyle Hidden
    try {
        if (-not $run.WaitForExit(20000)) { $run.Kill(); $run.WaitForExit(); throw "Cleanup timed out: $scenario" }
        $expectedExit = if ($scenario -eq 'ambiguous-name') { 1 } else { 0 }
        if ($run.ExitCode -ne $expectedExit) { throw "Unexpected cleanup result: $scenario ($($run.ExitCode))" }
    } finally { $run.Dispose() }
    if ((Get-Content -LiteralPath (Join-Path $fixture 'widgets.json') -Raw).Trim() -ne 'preserve layouts') {
        throw 'Cleanup changed a layout file'
    }
    $legacyExists = Test-Path -LiteralPath (Join-Path $fixture 'studio-agent')
    $shouldRemain = $scenario -in @('unrelated', 'ambiguous-name')
    if ($legacyExists -ne $shouldRemain) {
        throw "Unexpected cleanup result: $scenario"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $outside 'keep.txt'))) { throw "Cleanup followed a directory junction: $scenario" }
}
Write-Output 'Upgrade cleanup passed: old Node and node_modules removed; layouts and unrelated directories preserved.'
Write-Output 'Root and child junction targets preserved; ambiguous directory names fail closed.'

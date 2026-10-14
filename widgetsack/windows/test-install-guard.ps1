# Test native installer guards with owned executables. Never invokes an installed uninstaller.
param([string]$Compiler = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe")
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$testRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target\installer-guard-$([guid]::NewGuid().ToString('N'))"))
if (-not $testRoot.StartsWith("$repoRoot\target\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture path' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$template = @'
Unicode true
Name "widgetsack guard fixture"
OutFile "@OUTPUT@"
RequestExecutionLevel user
SilentInstall silent
Var PassiveMode
!define MAINBINARYNAME "widgetsack"
!include "@HOOKS@"
!insertmacro _WS_DEFINE_REMOVE_TREE ""
Section
StrCpy $INSTDIR "@FIXTURE@"
StrCpy $PassiveMode 0
!insertmacro NSIS_HOOK_PREINSTALL
FileOpen $0 "$INSTDIR\passed.txt" w
FileWrite $0 "passed"
FileClose $0
SectionEnd
'@
$install = Join-Path $testRoot 'install Δ'
$other = Join-Path $testRoot 'other copy'
New-Item -ItemType Directory -Path $install, $other | Out-Null
$script = Join-Path $testRoot 'guard.nsi'
$output = Join-Path $testRoot 'guard.exe'
$text = $template.Replace('@OUTPUT@', $output.Replace('$', '$$')).Replace('@FIXTURE@', $install.Replace('$', '$$')).Replace('@HOOKS@', (Join-Path $PSScriptRoot 'hooks.nsh').Replace('$', '$$'))
Set-Content -LiteralPath $script -Value $text -Encoding utf8
& $Compiler /INPUTCHARSET UTF8 /V2 $script
if ($LASTEXITCODE -ne 0) { throw 'Guard fixture compilation failed' }
$csharp = Join-Path $testRoot 'waiter.cs'
Set-Content -LiteralPath $csharp -Value 'class Waiter { static void Main(string[] args) { System.IO.File.WriteAllText(args[0], "ready"); System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); } }'
$app = Join-Path $install 'widgetsack.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe "/out:$app" $csharp
if ($LASTEXITCODE -ne 0) { throw 'Owned executable compilation failed' }
Copy-Item -LiteralPath $app -Destination (Join-Path $other 'widgetsack.exe')
$appHash = (Get-FileHash -LiteralPath $app).Hash
$children = [Collections.Generic.List[Diagnostics.Process]]::new()
function Start-Owned([string]$folder) {
    $ready = Join-Path $folder 'ready.txt'
    if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready }
    $child = Start-Process -FilePath (Join-Path $folder 'widgetsack.exe') -ArgumentList "`"$ready`"" -PassThru -WindowStyle Hidden
    $children.Add($child)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $ready)) {
        if ($child.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Owned process failed to become ready' }
        Start-Sleep -Milliseconds 20
    }
    return $child
}
function Run-Guard([bool]$expected) {
    $run = Start-Process -FilePath $output -Wait -PassThru -WindowStyle Hidden
    if (($run.ExitCode -eq 0) -ne $expected) { throw "Unexpected guard exit: $($run.ExitCode); fixture=$testRoot" }
    if ((Test-Path -LiteralPath (Join-Path $install 'passed.txt')) -ne $expected) { throw 'Guard continued with a locked executable' }
}
try {
    $installed = Start-Owned $install
    $unrelated = Start-Owned $other
    $legacy = Join-Path $install 'studio-agent\node_modules\example'
    New-Item -ItemType Directory -Path $legacy | Out-Null
    Set-Content -LiteralPath (Join-Path $legacy 'index.js') -Value 'old dependency'
    Run-Guard $false
    if (-not (Test-Path -LiteralPath $legacy)) { throw 'Blocked upgrade removed resources' }
    if ($installed.HasExited -or $unrelated.HasExited) { throw 'Guard terminated an application' }
    $installed.Kill()
    $installed.WaitForExit()
    $lock = [IO.File]::Open((Join-Path $legacy 'index.js'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Run-Guard $false } finally { $lock.Dispose() }
    Run-Guard $true
    if ((Get-FileHash -LiteralPath $app).Hash -ne $appHash) { throw 'Guard changed executable contents' }
    if (Test-Path -LiteralPath $legacy) { throw 'Upgrade retained old agent dependencies' }
    if ($unrelated.HasExited) { throw 'Guard affected an unrelated same-name application' }
    Remove-Item -LiteralPath (Join-Path $install 'passed.txt')
    Remove-Item -LiteralPath $app
    New-Item -ItemType Directory -Path $legacy -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $legacy 'index.js') -Value 'unrelated directory'
    Run-Guard $true
    if (Test-Path -LiteralPath $app) { throw 'Guard created an executable on a fresh install' }
    if (-not (Test-Path -LiteralPath $legacy)) { throw 'Fresh install removed an unrelated directory' }

    # A harmless old-uninstaller sentry proves replacement never executes the previous binary.
    $sentry = @'
Unicode true
Name "old uninstaller sentry"
OutFile "@OUTPUT@"
RequestExecutionLevel user
SilentInstall silent
Section
FileOpen $0 "@FIXTURE@\old-uninstaller.txt" w
FileWrite $0 "old code executed"
FileClose $0
SectionEnd
'@
    $replacement = @'
Unicode true
Name "replacement fixture"
OutFile "@OUTPUT@"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Var PassiveMode
!define MAINBINARYNAME "widgetsack"
!include "@HOOKS@"
!insertmacro _WS_DEFINE_REMOVE_TREE ""
!insertmacro _WS_DEFINE_REMOVE_TREE "un."
Section
StrCpy $INSTDIR "@FIXTURE@"
!insertmacro _WS_REPLACEMENT_UNINSTALLER
StrCpy $R1 "$R1 /S _?=$INSTDIR"
ExecWait '$R1' $0
SetErrorLevel $0
Quit
SectionEnd
Section Uninstall
StrCpy $PassiveMode 0
!insertmacro NSIS_HOOK_PREUNINSTALL
FileOpen $0 "$INSTDIR\new-uninstaller.txt" w
FileWrite $0 "guarded replacement"
FileClose $0
SectionEnd
'@
    foreach ($definition in @(
        @{ Name = 'old'; Source = $sentry; Output = (Join-Path $install 'uninstall.exe') },
        @{ Name = 'replacement'; Source = $replacement; Output = (Join-Path $testRoot 'replacement.exe') }
    )) {
        $script = Join-Path $testRoot "$($definition.Name).nsi"
        $text = $definition.Source.Replace('@OUTPUT@', $definition.Output.Replace('$', '$$')).Replace('@FIXTURE@', $install.Replace('$', '$$')).Replace('@HOOKS@', (Join-Path $PSScriptRoot 'hooks.nsh').Replace('$', '$$'))
        Set-Content -LiteralPath $script -Value $text -Encoding utf8
        & $Compiler /INPUTCHARSET UTF8 /V2 $script
        if ($LASTEXITCODE -ne 0) { throw 'Replacement fixture compilation failed' }
    }
    Copy-Item -LiteralPath (Join-Path $other 'widgetsack.exe') -Destination $app
    $replacementChild = Start-Owned $install
    $replacementExe = Join-Path $testRoot 'replacement.exe'
    $run = Start-Process -FilePath $replacementExe -Wait -PassThru -WindowStyle Hidden
    if ($run.ExitCode -eq 0 -or (Test-Path -LiteralPath (Join-Path $install 'new-uninstaller.txt'))) { throw 'Replacement bypassed the running-app guard' }
    if ($replacementChild.HasExited -or $unrelated.HasExited) { throw 'Replacement terminated a process' }
    $replacementChild.Kill()
    $replacementChild.WaitForExit()
    $run = Start-Process -FilePath $replacementExe -Wait -PassThru -WindowStyle Hidden
    if ($run.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $install 'new-uninstaller.txt'))) { throw 'Guarded replacement failed' }
    if (Test-Path -LiteralPath (Join-Path $install 'old-uninstaller.txt')) { throw 'Replacement ran the old uninstaller' }
    if ($unrelated.HasExited) { throw 'Replacement affected an unrelated process' }

    # Enter the non-silent guard branch after hidden setup, without opening an installer dialog.
    Remove-Item -LiteralPath (Join-Path $install 'passed.txt')
    $passiveChild = Start-Owned $install
    $script = Join-Path $testRoot 'passive.nsi'
    $passiveOutput = Join-Path $testRoot 'passive.exe'
    $text = $template.Replace('StrCpy $PassiveMode 0', "StrCpy `$PassiveMode 1`r`nSetSilent normal").Replace('@OUTPUT@', $passiveOutput.Replace('$', '$$')).Replace('@FIXTURE@', $install.Replace('$', '$$')).Replace('@HOOKS@', (Join-Path $PSScriptRoot 'hooks.nsh').Replace('$', '$$'))
    Set-Content -LiteralPath $script -Value $text -Encoding utf8
    & $Compiler /INPUTCHARSET UTF8 /V2 $script
    if ($LASTEXITCODE -ne 0) { throw 'Passive guard fixture compilation failed' }
    $run = Start-Process -FilePath $passiveOutput -Wait -PassThru -WindowStyle Hidden
    if ($run.ExitCode -eq 0 -or $passiveChild.HasExited -or $unrelated.HasExited) { throw 'Passive guard did not refuse the running app safely' }
    $passiveChild.Kill()
    $passiveChild.WaitForExit()
    New-Item -ItemType Directory -Path $legacy -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $legacy 'index.js') -Value 'locked dependency'
    $lock = [IO.File]::Open((Join-Path $legacy 'index.js'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        $run = Start-Process -FilePath $passiveOutput -Wait -PassThru -WindowStyle Hidden
        if ($run.ExitCode -eq 0) { throw 'Passive setup reported success after cleanup failed' }
    } finally { $lock.Dispose() }

    $hooks = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'hooks.nsh') -Raw
    $installer = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer.nsi') -Raw
    if ($hooks -match 'taskkill|KillProcess' -or $installer -match '!insertmacro CheckIfAppIsRunning') { throw 'Installer retains image-name shutdown' }
    if ($installer -notmatch '!insertmacro _WS_REPLACEMENT_UNINSTALLER') { throw 'Upgrade does not use the guarded replacement' }
    Write-Output 'Installer guard passed: locked app refused; closed and fresh installs allowed; unrelated process preserved.'
    Write-Output 'Upgrade replacement passed: new guarded uninstaller used; old executable never invoked.'
    Write-Output 'Passive guard passed without opening an interactive dialog.'
} finally {
    foreach ($child in $children) {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
    }
}

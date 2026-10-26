# Windows installer

The NSIS template is in `widgetsack/windows/installer.nsi`.
Its hooks are in `widgetsack/windows/hooks.nsh`.
Reconcile the template with Tauri when you update the bundler.

The release workflow pins Tauri CLI 2.12.4 (bundler 2.10.4). Use that CLI version for local installer
builds too, for example `npx --yes @tauri-apps/cli@2.12.4 build --bundles nsis --no-sign`.
Static MSVC runtime linking is configured through `build.windows.staticVCRuntime` in
`widgetsack/tauri.conf.json`. Older CLIs set the deprecated `STATIC_VCRUNTIME` environment variable
automatically, so upgrading the CLI is required to eliminate that warning.

## Running applications

Install and uninstall check write access to the executable in the selected installation directory.
The check uses [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
with `OPEN_EXISTING`. It does not write or truncate the file.
Missing files and directories are valid for a fresh installation.

If the executable is unavailable:

- Interactive setup asks the user to save Studio changes and exit that copy of Widgetsack.
- Retry repeats the check. Cancel exits with a nonzero status.
- Silent and passive setup exit with a nonzero status without closing applications.

Do not restore `taskkill` or Tauri's image-name `CheckIfAppIsRunning` calls.
Those calls can terminate development and portable copies outside the installation.

## Replacement and cleanup

An upgrade that needs to uninstall an NSIS installation generates a temporary uninstaller
from the current template. It passes the original installation directory to that uninstaller.
It does not execute the old uninstaller, which can contain global shutdown hooks.
WiX migration keeps its existing MSI uninstall path.

Legacy `studio-agent` resources are removed before file replacement or uninstall, after the app check.
Cleanup requires an existing Widgetsack executable. A fresh installation does not remove an unrelated
directory with that name. Cleanup failure stops setup with a nonzero status.
Layout files and installed external agents are outside this cleanup path.
The directory walk removes reparse points without visiting their targets.
Ambiguous names with a trailing dot or space stop cleanup instead of resolving to another path.

## Verification

Run from the repository root:

```powershell
./widgetsack/windows/test-install-guard.ps1
./widgetsack/windows/test-agent-cleanup.ps1
npx --yes @tauri-apps/cli@2.12.4 build --bundles nsis --no-sign
```

For hook or template changes after the application is built, use
`npx --yes @tauri-apps/cli@2.12.4 bundle --bundles nsis --no-sign` to compile a new installer from that binary.

The fixture scripts compile temporary installers beneath `target/`.
The guard test creates owned processes and terminates only those processes during cleanup.
It checks running, closed, and fresh installations, resource cleanup, unrelated same-name processes,
and replacement uninstaller behavior. It does not run the installed app's uninstaller.

The fixture tests run without an interactive installer dialog.
Check the Retry and Cancel buttons manually before release, using a temporary installation.

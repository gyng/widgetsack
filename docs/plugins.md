# Plugins

Plugins connect widgets to external services.
Packages can add widget templates, themes, and sensor sources.

## Configure a connection

1. Open **Plugins** in Studio.
2. Select the service you want to use.
3. Enter its connection settings.
4. Save the settings.
5. Use the connection test when one is available.

The widget list shows a configuration link for Home Assistant and AI Provider.
Use this link when a widget reports that its connection is not configured.

## Calendar feed

Select **Agenda** in Plugins and enter an ICS calendar address.
Keep a private calendar address secret. `webcal://` addresses also work.
After you save the address, leave the field blank to keep it.
Add an Agenda widget to show the events, or use **Status / Alerts** for meeting reminders.

Times appear in the computer's local timezone.
The feed can supply its own timezone rules or use IANA timezone names.
Repeating events are expanded for the next 366 days.
Non-repeating future events can appear beyond this period.
The list holds up to 2,048 events. A warning appears when it reaches this limit or some events cannot be read.

## Install a package

1. Open **Plugins**.
2. Find **Packages**.
3. Enter a package URL or GitHub repository in **Install a package**.
4. Select **Install**.
5. Enable the package after you review its requested permissions.

Accepted sources include `owner/repo`, a GitHub repository URL, and an HTTPS URL ending in `plugin.json`.
A repository URL uses its `main` branch.
Use a GitHub `tree/<ref>` URL to select a branch or tag.

New packages are disabled.
The enable prompt lists network hosts and widget or theme features that need approval.
Embedded pages in shared widgets stay sandboxed after parameter changes.
Only enable packages from sources you trust.

## Use a package

Enabled templates appear in **Layout → Add** and **Build**.
Insert a template to create a copy in your layout.
Package sensors appear in **Sensors** with IDs that start with `pkg.`.

## Update or remove a package

Select **Check updates** on a package installed from a URL.
Select **Update** if a different version is available.
Updates are checked only when you request them.
Review any new permissions before you enable an updated source or theme.

Disable a package to stop its source and remove its templates and theme from the catalog.
Select **Remove** to delete the installed package.
Packages copied into the configuration folder have no automatic update source.

For package creation and manual installation paths, see [Plugin packages](dev/plugin-packages.md).

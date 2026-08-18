# Recent Edits

A sidebar panel for Obsidian that shows files modified in the last *N* days, grouped by calendar day. Marks files edited from outside Obsidian — filesystem writes, sync from another device, plugins that write programmatically — with a configurable indicator dot.

![Recent Edits panel](assets/recent-edits-screenshot.png)

## Why this exists

Most **Recent Files** plugins for Obsidian show recently *opened* files, not recently *modified* ones. As I use my vault together with AI tools, I thought it would be useful to see recently modified files and distinguish between edits I've made in Obsidian and those made by the file system. This is useful when using:

- An external editor or script writing through the filesystem
- AI assistants editing notes via filesystem APIs

Recent Edits closes that gap. It shows what changed, when it changed, and visually flags edits that came from outside Obsidian's editor.

## Features

- Files modified in the last 7 days (configurable, 1–90 days), grouped by calendar day
- Day headers labelled `Today` / `Yesterday` / `YYYY-MM-DD (Ddd)`, sorted most recent first
- Configurable indicator dot for edits that came from outside Obsidian's editor
- "Background folders" toggle: hide noisy folders by default, reveal inline via toggle
- "Excluded folders" to permanently hide certain edits
- Copy any file's absolute filesystem path from its row for handing off to AI tools or the CLI (desktop only); the copy control can be a button, the folder-path text, or both
- Right-click → **Clear from list** to dismiss a file from the panel until its next edit
- Optional hover preview (uses the Page Preview core plugin)
- Panel controls in the top day-header row: a gear to open settings, and a button to switch how days display — expanded, collapsed, or reveal-on-hover
- Optional file-size change indicator: a subtle green/red chevron after a filename showing whether the file grew or shrank since its previous edit, with a configurable KB threshold
- Two row layouts: two lines (filename plus folder path) or one line (filename only, path still on hover) when you want more entries on screen
- Pin any note to a **Pinned** section that opens from the day header, so notes you're actively working on stay one click away as they slide down the log
- Includes `.md`, `.canvas`, and `.base` files

## Install

### Plugin Directory
1. Open Obsidian → Settings (⌘,) → Community plugins
2. If you see "Restricted mode is on", click Turn on community plugins
3. Click Browse
4. Search "Recent Edits"
5. Click Install → then Enable
6. Open the panel via the History ribbon icon, or Cmd-P → "Recent Edits: Open panel"

### Via BRAT (For Pre-release Betas)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from the Community plugins directory.
2. In Obsidian: Settings → BRAT → **Add Beta plugin**.
3. Paste: `cwagner223355/obsidian-recent-edits`
4. Enable **Recent Edits** in Community plugins.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| Lookback days | number | `7` | How many days back to include. Range 1–90. |
| Row layout | dropdown | Two lines | Two lines shows the folder path under the filename. One line drops it to fit more entries on screen; the full path is still available by hovering the filename. |
| External edit indicator color | color | `#D97757` | Color of the dot shown next to externally-edited files. |
| File size change indicator | toggle | off | Show a subtle up/down chevron after a filename when the file grew (green) or shrank (red) since its previous edit. |
| Size change threshold (KB) | number | `10` | Minimum size change, in KB, for the indicator to appear. Smaller changes are ignored. |
| Copy absolute path affordance | dropdown | Button above the time | Which control copies a row's absolute filesystem path: a button, the folder-path text, or both (desktop only). |
| Hover preview | toggle | off | Show Obsidian's page preview popup on hover. Requires the Page Preview core plugin. |
| Background folders | folder list | `[]` | Hidden by default; revealed by the per-day-header toggle. Useful for files that update often but you only check occasionally. |
| Excluded folders | folder list | `[]` | Hidden completely. Dot-prefixed folders (`.obsidian`, `.trash`) are always excluded regardless. |

Settings are grouped into **Row display**, **Behavior**, **Filtering**, and **Support**. Hover preview lives under Behavior.

In one-line layout there is no folder-path text to click, so the copy control is always the button regardless of what the affordance setting says. Your stored preference is kept and applies again when you switch back to two lines.

## Row interactions

| Click target | Action |
|---|---|
| Filename | Open the file. Activates an existing tab if open; otherwise opens a new one. |
| Cmd/Ctrl-click filename | Always open in a new tab. |
| Copy-path button / folder path (per the affordance setting) | Copy the file's absolute filesystem path to the clipboard (desktop only). |
| Pin icon on a row | Pin or unpin the note. The icon is hidden until you hover the row; once pinned it stays visible and tinted so you can spot pinned notes while scanning. |
| Right-click anywhere on the row | Open in new tab / split / window, Copy path (vault-relative), Rename, Delete, Pin, Clear from list. |
| Day header | Collapse or expand the day's group. |
| Day-mode button (top day header) | Cycle how day groups display: expanded → collapsed → reveal-on-hover. Choice persists. |
| Gear (top day header) | Open the plugin's settings. |
| **More** / **Less** pill on a day header | Toggle whether files in your background folders are shown. Only appears if you've configured background folders. |
| **Pinned** pill (top day header) | Hover to peek at your pinned notes, or click to hold the section open. When held open it pushes the day list down instead of covering it. |

## Pinned notes

Recent Edits is a running log, so a note you're actively working on slides down and eventually out as other files get touched. Pinning gives those notes a second home without disturbing the log.

A pinned note keeps its normal chronological place in the day groups. It also shows up in a **Pinned** section that opens from the pill in the top day header. Hover the pill to peek at the list; click it to hold the section open, which pushes the day list down rather than covering it. Press Escape to release it.

Pin a note from the pin icon on its row (hidden until you hover, visible and tinted once pinned) or from the right-click menu.

Two things worth knowing:

- **Pins ignore your filters.** A pinned note shows up in the section even if it sits in an excluded or background folder, or you've cleared it from the list. An explicit pin is a stronger signal than a filter. The day list itself still honors every filter.
- **Pins don't expire.** They survive the lookback window, so a note you pinned in March is still there in August. Pins only disappear when you unpin them or delete the file.

Because pinned notes can span any range of dates, their rows show a relative timestamp instead of a clock time: the time if it was edited today, a weekday name for the last week, and a date beyond that. Hover any of them for the full timestamp.

## How the external-edit indicator works

The classifier combines a few signals:

- `editor-change` events (fires when a file is being edited inside Obsidian's editor).
- `vault.create` / `vault.modify` events (fire for any change, including writes from outside Obsidian).
- `workspace.file-open` events (used to recognize core-plugin flows that create-and-open a file, like Daily Notes from the command palette).
- File size at create time (a brand-new empty file is treated as Obsidian-internal — wikilink click, "New note" command, etc.).

A file is classified as an external edit only when none of those internal signals fire near the create or modify event.

### Potential limitations

The external-edit status is meant to be an indicator, not a perfect signal. It could mistake:

- Edits arriving via Obsidian Sync from another device.
- Plugin background writes that never open the file in a workspace leaf (rare in practice).
- Files modified before the plugin was installed (these stay unclassified until the next time they're touched).

## Support

Recent Edits is free and always will be. If it earns a place in your daily workflow, a coffee helps keep it maintained. There's a link in the plugin's settings too, under **Support**.

<a href='https://ko-fi.com/S6S6Z9TE1' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi6.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>

## License

MIT — see [LICENSE](LICENSE).

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
| Hover preview | toggle | off | Show Obsidian's page preview popup on hover. Requires the Page Preview core plugin. |
| External edit indicator color | color | `#D97757` | Color of the dot shown next to externally-edited files. |
| Copy absolute path affordance | dropdown | Button above the time | Which control copies a row's absolute filesystem path: a button, the folder-path text, or both (desktop only). |
| Background folders | folder list | `[]` | Hidden by default; revealed by the per-day-header toggle. Useful for files that update often but you only check occasionally. |
| Excluded folders | folder list | `[]` | Hidden completely. Dot-prefixed folders (`.obsidian`, `.trash`) are always excluded regardless. |

## Row interactions

| Click target | Action |
|---|---|
| Filename | Open the file. Activates an existing tab if open; otherwise opens a new one. |
| Cmd/Ctrl-click filename | Always open in a new tab. |
| Copy-path button / folder path (per the affordance setting) | Copy the file's absolute filesystem path to the clipboard (desktop only). |
| Right-click anywhere on the row | Open in new tab / split / window, Copy path (vault-relative), Rename, Delete, Clear from list. |
| Day header | Collapse or expand the day's group. |
| **More** / **Less** pill on a day header | Toggle whether files in your background folders are shown. Only appears if you've configured background folders. |

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

If Recent Edits is useful to you, consider [buying me a coffee](https://ko-fi.com/S6S6Z9TE1).

<a href='https://ko-fi.com/S6S6Z9TE1' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi2.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>

## License

MIT — see [LICENSE](LICENSE).

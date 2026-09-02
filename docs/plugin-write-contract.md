# Plugin-declared writes

A contract between Recent Edits and any other plugin that rewrites notes as housekeeping. Available since Recent Edits 1.6.0.

## The problem it solves

Recent Edits classifies every `vault.modify` event as either an edit made inside Obsidian's editor or an external write, and shows the file under the time of that write. It has no third category. A plugin that reorders frontmatter keys, inserts scaffold fields, normalizes YAML, or otherwise rewrites a note on the user's behalf produces a `modify` event that is indistinguishable from the user editing the note. The note jumps to the top of the panel, and if the plugin wrote from a `file-open` or `active-leaf-change` handler more than two seconds after the open, it also picks up the external-edit dot.

The contract lets the writing plugin say "this one is mine" before it writes.

## The event

Fire this on the workspace immediately before the write:

```ts
app.workspace.trigger("recent-edits:plugin-write", { path: file.path });
```

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | Vault-relative path of the file about to be written, exactly as `TFile.path` reports it. |

Nothing else is read from the payload. Unknown fields are ignored, so you can add your own for other listeners.

## What Recent Edits does with it

1. On receipt, it records the path with the current time and the file's current `stat.mtime` (the pre-write mtime).
2. When the next `vault.modify` for that path arrives within **5 seconds**, it skips classification entirely: no `obsidian` or `external` source, no timestamp bump, no external-edit dot, no size-change indicator.
3. If the file had no recorded edit time yet, Recent Edits pins one to the pre-write mtime. Without that, a never-classified file would fall back to `stat.mtime` and surface anyway.
4. The size baseline is refreshed quietly, so the next real edit's size delta is measured from the file as it is now.
5. The declaration is consumed by that one `modify`. It expires after 5 seconds if no write follows, so a declaration followed by a skipped write (for example, Obsidian's `Vault.process` returning early because the text was unchanged) is harmless.

`vault.create` events are never treated as declared writes. A plugin that creates a note made something the user will want to see; declare only rewrites of existing notes.

The user can turn the behavior off with **Ignore plugin-declared writes** in the Recent Edits settings (Behavior group, on by default). When it is off, every `modify` is classified as before and declarations are ignored.

## When to declare, and when not to

Declare a write when the user did not ask for it on that specific note and would not call it an edit:

- Reordering frontmatter keys to a canonical order
- Inserting empty scaffold fields from a template
- Removing null fields as cleanup
- Normalizing formatting, line endings, or YAML serialization
- Bulk operations the user triggered once but that touch many notes (a vault-wide scrub, a field migration)

Do not declare:

- A write the user asked for on that note (a context-menu action, a command they ran while looking at it)
- Content the user will want to find in Recent Edits (a note your plugin created or generated for them)
- Anything you are not certain is housekeeping

The test: would the user be surprised to see this note at the top of a "what did I work on" list? If yes, declare.

## Integration pattern

Wrap the trigger in a small helper and call it before every housekeeping write site, not at the top of a function that may return early without writing:

```ts
private announceWrite(file: TFile): void {
  try {
    this.app.workspace.trigger("recent-edits:plugin-write", { path: file.path });
  } catch (e) {
    console.warn("[my-plugin] announceWrite failed", e);
  }
}

// ...

this.announceWrite(file);
await this.app.fileManager.processFrontMatter(file, (fm) => { /* ... */ });
```

Fire it as close to the write as possible so the 5-second window can't be consumed by an unrelated write to the same file. If your write path has a fast path that returns without writing, announce after that check, not before.

If Recent Edits is not installed, `trigger` has no listeners and nothing happens. There is no need to detect the plugin first.

## Listening for it yourself

If you maintain a plugin with a similar problem (any "what changed recently" surface), you can honor the same event. `Workspace.on` narrows event names to Obsidian's own literals, so a custom name has to go through the `Events` base class:

```ts
import { Events } from "obsidian";

this.registerEvent(
  (this.app.workspace as Events).on("recent-edits:plugin-write", (...data: unknown[]) => {
    const payload = data[0] as { path?: unknown } | undefined;
    if (typeof payload?.path === "string") {
      // remember payload.path for a few seconds; skip the next modify on it
    }
  })
);
```

## Reference implementation

Recent Edits: `main.ts`, the `recent-edits:plugin-write` listener in `onload` and the guard at the top of `classifyEdit`. First adopter: [Foldable Frontmatter Groups](https://github.com/cwagner223355/obsidian-foldable-frontmatter-groups), which declares its reconcile, create-time defaults, body-template insert, cleanup scrubs, and field migrations, and deliberately does not declare its context-menu "Remove property" or the conflict checklist note it generates.

## Versioning

- Introduced in Recent Edits 1.6.0.
- The event name and the `path` field are stable. New optional fields may be added; none will be removed.

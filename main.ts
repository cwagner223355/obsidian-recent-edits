import {
  App,
  FileSystemAdapter,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";

type PathCopyAffordance = "button" | "path-text" | "both";
type DayOpenMode = "open" | "collapsed" | "hover";

interface RecentEditsSettings {
  excludedFolders: string[];
  backgroundFolders: string[];
  lookbackDays: number;
  enableHoverPreview: boolean;
  externalEditColor: string;
  pathCopyAffordance: PathCopyAffordance;
  showSizeIndicator: boolean;
  sizeDeltaThresholdKb: number;
  dayOpenMode: DayOpenMode;
}

const DEFAULT_SETTINGS: RecentEditsSettings = {
  excludedFolders: [],
  backgroundFolders: [],
  lookbackDays: 7,
  enableHoverPreview: false,
  externalEditColor: "#D97757",
  pathCopyAffordance: "button",
  showSizeIndicator: false,
  sizeDeltaThresholdKb: 10,
  dayOpenMode: "open",
};

const VIEW_TYPE_RECENT_EDITS = "recent-edits-view";
const SUPPORTED_EXTENSIONS = new Set(["md", "canvas", "base"]);
const HOVER_SOURCE = "recent-edits";
const EDITOR_CHANGE_WINDOW_MS = 5000;
// Longer window used to decide whether an external edit is a local Claude
// follow-up to recent Obsidian editing on this file (vs. a sync delivery).
const ACTIVE_LOCAL_FILE_WINDOW_MS = 5 * 60 * 1000;
// Threshold for "the canonical mtime is far enough behind stat.mtime that
// this is clearly a new edit, not a sync follow-up." Keeps us from
// overwriting Mac's canonical with a sync-receipt time when sync delivers
// a file from mobile shortly after mobile edited it.
const EXTERNAL_SYNC_GUARD_MS = 60_000;
const FILE_OPEN_WINDOW_MS = 2000;
const CREATE_CLASSIFY_DELAY_MS = 800;

type EditSource = "obsidian" | "external";

export default class RecentEditsPlugin extends Plugin {
  settings: RecentEditsSettings = DEFAULT_SETTINGS;
  editSources: Record<string, EditSource> = {};
  editTimes: Record<string, number> = {};
  dismissedAt: Record<string, number> = {};
  editSizes: Record<string, number> = {};
  sizeDeltas: Record<string, "up" | "down"> = {};
  private editorChangeTimes = new Map<string, number>();
  private recentFileOpens = new Map<string, number>();
  private saveDataTimer: number | null = null;
  private midnightTimer: number | null = null;
  private createTimers = new Set<number>();

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_RECENT_EDITS,
      (leaf) => new RecentEditsView(leaf, this)
    );

    this.addRibbonIcon("history", "Recent Edits", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open",
      name: "Open panel",
      callback: () => { void this.activateView(); },
    });

    // Register with Page Preview so this source appears in its settings and
    // honors plain-hover (defaultMod: false); without this the hover-preview
    // toggle silently requires the Ctrl/Cmd modifier.
    this.registerHoverLinkSource(HOVER_SOURCE, {
      display: "Recent Edits",
      defaultMod: false,
    });

    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const file = (info as { file?: TFile | null })?.file;
        if (file && file.path) {
          this.editorChangeTimes.set(file.path, Date.now());
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.path) {
          this.recentFileOpens.set(file.path, Date.now());
        }
      })
    );

    // Register the create handler at layout-ready, not in onload. Obsidian
    // fires `create` for every existing file during vault initialization, so a
    // handler registered in onload would classify the entire vault at startup
    // (marking every recent file external on a fresh install) and spawn a
    // deferred timer per file. Registering after layout-ready skips that storm;
    // the layoutReady guard is a backstop for the pre-ready window.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!this.app.workspace.layoutReady) return;
          if (file instanceof TFile) {
            // Defer classification so workspace `file-open` has time to fire.
            // Core-plugin flows (Daily Notes, Templater, "New note from
            // template") create the file then open it; the file-open is
            // our signal that this was an Obsidian-internal create.
            const timer = window.setTimeout(() => {
              this.createTimers.delete(timer);
              if (this.app.vault.getAbstractFileByPath(file.path) === file) {
                this.classifyEdit(file, true);
                this.refreshViews();
              }
            }, CREATE_CLASSIFY_DELAY_MS);
            this.createTimers.add(timer);
          }
          this.refreshViews();
        })
      );
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.classifyEdit(file, false);
        }
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          let changed = false;
          if (this.editSources[file.path]) {
            delete this.editSources[file.path];
            changed = true;
          }
          if (this.editTimes[file.path] !== undefined) {
            delete this.editTimes[file.path];
            changed = true;
          }
          if (this.dismissedAt[file.path] !== undefined) {
            delete this.dismissedAt[file.path];
            changed = true;
          }
          if (this.editSizes[file.path] !== undefined) {
            delete this.editSizes[file.path];
            changed = true;
          }
          if (this.sizeDeltas[file.path] !== undefined) {
            delete this.sizeDeltas[file.path];
            changed = true;
          }
          if (changed) this.scheduleSaveData();
        }
        this.refreshViews();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          let changed = false;
          if (this.editSources[oldPath]) {
            this.editSources[file.path] = this.editSources[oldPath];
            delete this.editSources[oldPath];
            changed = true;
          }
          if (this.editTimes[oldPath] !== undefined) {
            this.editTimes[file.path] = this.editTimes[oldPath];
            delete this.editTimes[oldPath];
            changed = true;
          }
          if (this.dismissedAt[oldPath] !== undefined) {
            this.dismissedAt[file.path] = this.dismissedAt[oldPath];
            delete this.dismissedAt[oldPath];
            changed = true;
          }
          if (this.editSizes[oldPath] !== undefined) {
            this.editSizes[file.path] = this.editSizes[oldPath];
            delete this.editSizes[oldPath];
            changed = true;
          }
          if (this.sizeDeltas[oldPath] !== undefined) {
            this.sizeDeltas[file.path] = this.sizeDeltas[oldPath];
            delete this.sizeDeltas[oldPath];
            changed = true;
          }
          if (changed) this.scheduleSaveData();
        }
        this.refreshViews();
      })
    );

    // Re-load persisted edit metadata when the Recent Edits leaf becomes
    // active. data.json may have been updated by Obsidian Sync from another
    // device while the view was inactive, and Obsidian doesn't fire vault
    // events for files inside `.obsidian/`.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view instanceof RecentEditsView) {
          void this.reloadEditMetadata();
        }
      })
    );

    this.addSettingTab(new RecentEditsSettingTab(this.app, this));

    // Re-render when the calendar day rolls over so the "Today" group reflects
    // the new day even when Obsidian was left open overnight with no vault
    // activity to trigger an event-driven refresh.
    this.scheduleMidnightRefresh();
  }

  onunload() {
    if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    for (const timer of this.createTimers) {
      window.clearTimeout(timer);
    }
    this.createTimers.clear();
    if (this.saveDataTimer !== null) {
      window.clearTimeout(this.saveDataTimer);
      this.saveDataTimer = null;
      // Flush any debounced edit metadata so the pending write doesn't fire on
      // this dead instance and race the next instance's load.
      void this.persistData();
    }
  }

  private scheduleMidnightRefresh() {
    if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
    }
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
      250
    );
    const delay = nextMidnight.getTime() - now.getTime();
    this.midnightTimer = window.setTimeout(() => {
      this.midnightTimer = null;
      this.refreshViews();
      this.scheduleMidnightRefresh();
    }, delay);
  }

  private classifyEdit(file: TFile, isCreate: boolean) {
    const lastChange = this.editorChangeTimes.get(file.path) ?? 0;
    const recentEditorChange =
      Date.now() - lastChange < EDITOR_CHANGE_WINDOW_MS;
    // Empty files at create time are Obsidian-internal (unresolved wikilink
    // click, "New note" command). External writes always carry content.
    const isEmptyCreate = isCreate && file.stat.size === 0;
    // Recent file-open signals a workspace-driven edit (core plugins like
    // Daily Notes, Templater, command-palette actions that open the file).
    const lastOpen = this.recentFileOpens.get(file.path) ?? 0;
    const recentFileOpen = Date.now() - lastOpen < FILE_OPEN_WINDOW_MS;
    const isObsidian = recentEditorChange || isEmptyCreate || recentFileOpen;

    // Both maps move in lockstep: a write to editSources is also a write to
    // editTimes. We only persist when this device originated the edit.
    //
    // Obsidian classifications always reflect a local edit — record them.
    //
    // External classifications are ambiguous: on desktop they're almost
    // always a local filesystem write (Claude Code, a script, etc.); on
    // mobile they're almost always a sync delivery from another device
    // carrying a sync-receipt-time stat.mtime. We split by platform:
    //
    //   Desktop: record an external edit as the local canonical when we're
    //   confident it's a real local write. Guard against the rare case
    //   where a sync delivery from mobile arrives — if a canonical value
    //   already exists and stat.mtime is within ~60s of it, treat as sync
    //   delivery and skip to preserve the canonical.
    //
    //   Mobile: never write on external. A sync delivery would otherwise
    //   overwrite Mac's canonical (both source and time) with sync data.
    let isLocallyOriginated = false;
    if (isObsidian) {
      isLocallyOriginated = true;
    } else if (Platform.isDesktop) {
      const persisted = this.editTimes[file.path];
      if (persisted === undefined) {
        // No canonical yet — safe to record.
        isLocallyOriginated = true;
      } else {
        const mtimeAdvance = file.stat.mtime - persisted;
        const recentLocalEditorChange =
          Date.now() - lastChange < ACTIVE_LOCAL_FILE_WINDOW_MS;
        // Two ways to be confident this is a local external write rather
        // than a sync delivery from mobile:
        //   (1) The canonical is far enough behind stat.mtime that it
        //       can't be a sync follow-up to the same logical edit.
        //   (2) This file was actively being edited in Obsidian on this
        //       device recently — Mac → Claude follow-ups land here even
        //       when the mtime advance is small.
        if (mtimeAdvance > EXTERNAL_SYNC_GUARD_MS || recentLocalEditorChange) {
          isLocallyOriginated = true;
        }
        // Otherwise: small mtime advance, no recent local Obsidian
        // activity on this file — preserve canonical (probably sync).
      }
    }

    if (isLocallyOriginated) {
      this.editSources[file.path] = isObsidian ? "obsidian" : "external";
      this.editTimes[file.path] = file.stat.mtime;
      this.recordSizeDelta(file);
      this.scheduleSaveData();
    }
    // Else: sync delivery (or indistinguishable). Preserve the originating
    // device's source and canonical mtime; the synced data.json carries
    // truth.
  }

  // Records the direction of this edit's size change vs. the file's previously
  // recorded size, then stores the new size. Called only for locally
  // originated edits so sync deliveries don't produce spurious deltas.
  private recordSizeDelta(file: TFile) {
    const prev = this.editSizes[file.path];
    if (prev !== undefined) {
      const diff = file.stat.size - prev;
      const threshold = this.settings.sizeDeltaThresholdKb * 1024;
      if (diff > 0 && diff >= threshold) this.sizeDeltas[file.path] = "up";
      else if (diff < 0 && -diff >= threshold) this.sizeDeltas[file.path] = "down";
      else delete this.sizeDeltas[file.path];
    }
    this.editSizes[file.path] = file.stat.size;
  }

  sizeDelta(file: TFile): "up" | "down" | undefined {
    return this.sizeDeltas[file.path];
  }

  isExternalEdit(file: TFile): boolean {
    return this.editSources[file.path] === "external";
  }

  effectiveMtime(file: TFile): number {
    return this.editTimes[file.path] ?? file.stat.mtime;
  }

  isDismissed(file: TFile): boolean {
    return this.dismissedAt[file.path] === file.stat.mtime;
  }

  dismissFile(file: TFile) {
    this.dismissedAt[file.path] = file.stat.mtime;
    this.scheduleSaveData();
    this.refreshViews();
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_RECENT_EDITS);
    let leaf: WorkspaceLeaf | null;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeftLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_RECENT_EDITS,
          active: true,
        });
      }
    }

    if (leaf) await workspace.revealLeaf(leaf);
  }

  refreshViews() {
    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_RECENT_EDITS)
      .forEach((leaf) => {
        const view = leaf.view;
        if (view instanceof RecentEditsView) {
          view.scheduleRefresh();
        }
      });
  }

  async loadSettings() {
    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    const editSources = (raw._editSources as
      | Record<string, EditSource>
      | undefined) ?? {};
    const editTimes = (raw._editTimes as
      | Record<string, number>
      | undefined) ?? {};
    const dismissedAt = (raw._dismissedAt as
      | Record<string, number>
      | undefined) ?? {};
    const editSizes = (raw._editSizes as
      | Record<string, number>
      | undefined) ?? {};
    const sizeDeltas = (raw._sizeDeltas as
      | Record<string, "up" | "down">
      | undefined) ?? {};
    const settingsBlob = { ...raw };
    delete (settingsBlob as Record<string, unknown>)._editSources;
    delete (settingsBlob as Record<string, unknown>)._editTimes;
    delete (settingsBlob as Record<string, unknown>)._dismissedAt;
    delete (settingsBlob as Record<string, unknown>)._editSizes;
    delete (settingsBlob as Record<string, unknown>)._sizeDeltas;

    // Copy only known settings keys so stray or legacy keys in data.json aren't
    // merged into settings and re-persisted forever.
    const blob = settingsBlob as Record<string, unknown>;
    const settings: RecentEditsSettings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof RecentEditsSettings)[]) {
      if (blob[key] !== undefined) {
        (settings as unknown as Record<string, unknown>)[key] = blob[key];
      }
    }
    // One-time migration: pre-1.0 stored the indicator color as claudeEditColor.
    if (
      blob.externalEditColor === undefined &&
      typeof blob.claudeEditColor === "string"
    ) {
      settings.externalEditColor = blob.claudeEditColor;
    }
    this.settings = settings;
    this.editSources = editSources;
    this.editTimes = editTimes;
    this.dismissedAt = dismissedAt;
    this.editSizes = editSizes;
    this.sizeDeltas = sizeDeltas;
  }

  // Re-reads persisted edit metadata (sources, times, dismissals) from
  // data.json without disturbing in-memory settings. Used to pick up
  // changes synced in from another device.
  async reloadEditMetadata() {
    // Flush any debounced local writes first. Otherwise a reload triggered
    // mid-batch would read a stale data.json and replace in-memory
    // classifications not yet persisted, then the pending save would write the
    // stale state back to disk.
    if (this.saveDataTimer !== null) {
      window.clearTimeout(this.saveDataTimer);
      this.saveDataTimer = null;
      await this.persistData();
    }
    const raw = ((await this.loadData()) as Record<string, unknown>) ?? {};
    const editSources = (raw._editSources as
      | Record<string, EditSource>
      | undefined) ?? {};
    const editTimes = (raw._editTimes as
      | Record<string, number>
      | undefined) ?? {};
    const dismissedAt = (raw._dismissedAt as
      | Record<string, number>
      | undefined) ?? {};
    const editSizes = (raw._editSizes as
      | Record<string, number>
      | undefined) ?? {};
    const sizeDeltas = (raw._sizeDeltas as
      | Record<string, "up" | "down">
      | undefined) ?? {};
    this.editSources = editSources;
    this.editTimes = editTimes;
    this.dismissedAt = dismissedAt;
    this.editSizes = editSizes;
    this.sizeDeltas = sizeDeltas;
    this.refreshViews();
  }

  async saveSettings() {
    await this.persistData();
    this.refreshViews();
  }

  private scheduleSaveData() {
    if (this.saveDataTimer !== null) {
      window.clearTimeout(this.saveDataTimer);
    }
    this.saveDataTimer = window.setTimeout(() => {
      void this.persistData();
      this.saveDataTimer = null;
    }, 500);
  }

  // Drop stale entries from the in-memory signal maps so they don't grow
  // unbounded over a long session. Kept above each map's read window.
  private pruneSignalMaps() {
    const now = Date.now();
    for (const [path, t] of this.editorChangeTimes) {
      if (now - t > ACTIVE_LOCAL_FILE_WINDOW_MS) this.editorChangeTimes.delete(path);
    }
    for (const [path, t] of this.recentFileOpens) {
      if (now - t > FILE_OPEN_WINDOW_MS) this.recentFileOpens.delete(path);
    }
  }

  private async persistData() {
    this.pruneSignalMaps();
    const cutoff = Date.now() - this.settings.lookbackDays * 86400000;
    // For pruning, use whichever timestamp is later: local stat.mtime or
    // the stored canonical mtime. On mobile, stat.mtime may be sync time
    // (newer than the canonical mtime), so we keep the entry. An entry is
    // only dropped if the file genuinely fell out of the lookback window
    // by every measure.
    const freshest = (path: string, file: TFile): number => {
      const stored = this.editTimes[path];
      return stored !== undefined ? Math.max(stored, file.stat.mtime) : file.stat.mtime;
    };

    const prunedSources: Record<string, EditSource> = {};
    for (const [path, src] of Object.entries(this.editSources)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && freshest(path, file) >= cutoff) {
        prunedSources[path] = src;
      }
    }
    this.editSources = prunedSources;

    const prunedTimes: Record<string, number> = {};
    for (const [path, mtime] of Object.entries(this.editTimes)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && Math.max(mtime, file.stat.mtime) >= cutoff) {
        prunedTimes[path] = mtime;
      }
    }
    this.editTimes = prunedTimes;

    // Prune dismissals: drop entries for files that no longer exist, are
    // outside the lookback window, or whose mtime has advanced past the
    // dismissed mtime (the dismissal is stale and would auto-show anyway).
    const prunedDismissed: Record<string, number> = {};
    for (const [path, mtime] of Object.entries(this.dismissedAt)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (
        file instanceof TFile &&
        file.stat.mtime >= cutoff &&
        file.stat.mtime === mtime
      ) {
        prunedDismissed[path] = mtime;
      }
    }
    this.dismissedAt = prunedDismissed;

    const prunedSizes: Record<string, number> = {};
    for (const [path, size] of Object.entries(this.editSizes)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && freshest(path, file) >= cutoff) {
        prunedSizes[path] = size;
      }
    }
    this.editSizes = prunedSizes;

    // A size delta is only meaningful alongside a retained size entry.
    const prunedDeltas: Record<string, "up" | "down"> = {};
    for (const [path, dir] of Object.entries(this.sizeDeltas)) {
      if (this.editSizes[path] !== undefined) prunedDeltas[path] = dir;
    }
    this.sizeDeltas = prunedDeltas;

    await this.saveData({
      ...this.settings,
      _editSources: this.editSources,
      _editTimes: this.editTimes,
      _dismissedAt: this.dismissedAt,
      _editSizes: this.editSizes,
      _sizeDeltas: this.sizeDeltas,
    });
  }
}

interface DayGroup {
  key: string;
  date: Date;
  files: TFile[];
}

class RecentEditsView extends ItemView {
  plugin: RecentEditsPlugin;
  private collapsedDays = new Set<string>();
  private showBackgroundFolders = false;
  private refreshTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RecentEditsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RECENT_EDITS;
  }

  getDisplayText(): string {
    return "Recent Edits";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen() {
    // Pick up any persisted edit metadata that arrived via Obsidian Sync
    // since the last time this view rendered.
    await this.plugin.reloadEditMetadata();
    this.render();
  }

  async onClose() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
  }

  private showFileMenu(evt: MouseEvent, file: TFile) {
    const menu = new Menu();
    const { workspace } = this.app;

    menu.addItem((item) =>
      item
        .setTitle("Open in new tab")
        .setIcon("lucide-file-plus")
        .onClick(() => {
          void workspace.getLeaf("tab").openFile(file);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Open to the right")
        .setIcon("lucide-separator-vertical")
        .onClick(() => {
          void workspace.getLeaf("split", "vertical").openFile(file);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Open in new window")
        .setIcon("lucide-monitor")
        .onClick(() => {
          void workspace.getLeaf("window").openFile(file);
        })
    );

    workspace.trigger("file-menu", menu, file, "file-explorer-context-menu");

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("Copy path")
        .setIcon("lucide-copy")
        .onClick(() => {
          void navigator.clipboard
            .writeText(file.path)
            .then(() => {}, () => new Notice("Copy failed"));
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("Rename…")
        .setIcon("lucide-pencil")
        .onClick(() => {
          new RenameFileModal(this.app, file).open();
        })
    );

    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("lucide-trash-2")
        .onClick(() => {
          new ConfirmDeleteModal(this.app, file).open();
        })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle("Clear from list")
        .setIcon("lucide-eye-off")
        .onClick(() => {
          this.plugin.dismissFile(file);
        })
    );

    menu.showAtMouseEvent(evt);
  }

  private async openInNewTab(file: TFile) {
    const workspace = this.app.workspace;
    const leaf = workspace.getLeaf("tab");
    await leaf.openFile(file);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  private findLeafForFile(file: TFile): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      // Match on the leaf's view state, not leaf.view: restored background tabs
      // are DeferredView until made visible and carry no `.file`, so a
      // leaf.view check misses them and clicking a row opens a duplicate tab.
      const state = leaf.getViewState().state as { file?: string } | undefined;
      if (state?.file === file.path) {
        found = leaf;
      }
    });
    return found;
  }

  scheduleRefresh() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.render();
      this.refreshTimer = null;
    }, 200);
  }

  private getRecentFiles(): DayGroup[] {
    const { lookbackDays, excludedFolders, backgroundFolders } =
      this.plugin.settings;
    const cutoff = Date.now() - lookbackDays * 86400000;
    const showBg = this.showBackgroundFolders;

    const matchesFolder = (path: string, folder: string): boolean => {
      const norm = folder.replace(/^\/+|\/+$/g, "");
      if (!norm) return false;
      return path === norm || path.startsWith(norm + "/");
    };

    const all = this.app.vault.getFiles();
    const filtered = all.filter((f) => {
      if (!SUPPORTED_EXTENSIONS.has(f.extension)) return false;
      // Use the later of stat.mtime and the persisted canonical mtime so a
      // file remains visible if either signal places it inside the window.
      const effective = this.plugin.effectiveMtime(f);
      if (Math.max(f.stat.mtime, effective) < cutoff) return false;

      const segs = f.path.split("/");
      for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i].startsWith(".")) return false;
      }

      for (const ex of excludedFolders) {
        if (matchesFolder(f.path, ex)) return false;
      }

      if (!showBg) {
        for (const bg of backgroundFolders) {
          if (matchesFolder(f.path, bg)) return false;
        }
      }

      if (this.plugin.isDismissed(f)) return false;
      return true;
    });

    const groupsMap = new Map<string, DayGroup>();
    for (const f of filtered) {
      const d = new Date(this.plugin.effectiveMtime(f));
      const key = formatDayKey(d);
      let g = groupsMap.get(key);
      if (!g) {
        g = { key, date: startOfLocalDay(d), files: [] };
        groupsMap.set(key, g);
      }
      g.files.push(f);
    }

    const groups = Array.from(groupsMap.values());
    groups.sort((a, b) => b.date.getTime() - a.date.getTime());
    for (const g of groups) {
      g.files.sort(
        (a, b) =>
          this.plugin.effectiveMtime(b) - this.plugin.effectiveMtime(a)
      );
    }
    return groups;
  }

  // Renders the day-mode + gear controls into a header element. Placed on the
  // top day header (or the empty-state bar) so they share an existing row and
  // cost no extra vertical space. Re-drawn on every render, so cycleDayMode
  // just re-renders to update the icon.
  private renderControls(target: HTMLElement) {
    const controls = target.createDiv({ cls: "recent-edits-controls" });

    const mode = this.plugin.settings.dayOpenMode;
    const modeBtn = controls.createDiv({
      cls: "clickable-icon recent-edits-control-btn",
      attr: { role: "button", tabindex: "0", "aria-label": dayModeLabel(mode) },
    });
    setIcon(modeBtn, dayModeIcon(mode));
    const cycle = (evt: Event) => {
      evt.stopPropagation();
      void this.cycleDayMode();
    };
    modeBtn.addEventListener("click", cycle);
    modeBtn.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        cycle(evt);
      }
    });

    const gearBtn = controls.createDiv({
      cls: "clickable-icon recent-edits-control-btn",
      attr: { role: "button", tabindex: "0", "aria-label": "Open settings" },
    });
    setIcon(gearBtn, "settings");
    const open = (evt: Event) => {
      evt.stopPropagation();
      this.openSettings();
    };
    gearBtn.addEventListener("click", open);
    gearBtn.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        open(evt);
      }
    });
  }

  private openSettings() {
    const setting = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    setting?.open();
    setting?.openTabById(this.plugin.manifest.id);
  }

  private async cycleDayMode() {
    const order: DayOpenMode[] = ["open", "collapsed", "hover"];
    const idx = order.indexOf(this.plugin.settings.dayOpenMode);
    this.plugin.settings.dayOpenMode = order[(idx + 1) % order.length];
    // Reset per-day overrides so the new mode's default applies cleanly.
    this.collapsedDays.clear();
    await this.plugin.saveSettings();
  }

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("recent-edits-container");
    container.style.setProperty(
      "--recent-edits-dot-color",
      this.plugin.settings.externalEditColor
    );
    container.dataset.dayMode = this.plugin.settings.dayOpenMode;

    const hasBackground = this.plugin.settings.backgroundFolders.length > 0;
    const groups = this.getRecentFiles();

    if (groups.length === 0) {
      const bar = container.createDiv({ cls: "recent-edits-empty-controls" });
      this.renderControls(bar);
      const days = this.plugin.settings.lookbackDays;
      const empty = container.createDiv({ cls: "recent-edits-empty" });
      empty.setText(
        `No edits in the last ${days} day${days === 1 ? "" : "s"}.`
      );
      if (hasBackground && !this.showBackgroundFolders) {
        const action = container.createDiv({
          cls: "recent-edits-empty-action",
        });
        const link = action.createEl("a", { text: "Show background folders" });
        link.addEventListener("click", (evt) => {
          evt.preventDefault();
          this.showBackgroundFolders = true;
          this.render();
        });
      }
      return;
    }

    const list = container.createDiv({ cls: "recent-edits-list" });
    groups.forEach((g, i) => {
      this.renderGroup(list, g, hasBackground, i === 0);
    });
  }

  private renderGroup(
    parent: HTMLElement,
    g: DayGroup,
    withBgToggle: boolean,
    isFirst: boolean
  ) {
    const groupEl = parent.createDiv({ cls: "recent-edits-group" });
    // "open" mode defaults to expanded; "collapsed" and "hover" default to
    // collapsed in the DOM (hover then reveals via CSS on mouse-over).
    // collapsedDays holds per-day overrides of that default.
    const defaultCollapsed = this.plugin.settings.dayOpenMode !== "open";
    const isCollapsed = () =>
      defaultCollapsed !== this.collapsedDays.has(g.key);
    if (isCollapsed()) groupEl.dataset.collapsed = "true";

    const header = groupEl.createDiv({ cls: "recent-edits-day-header" });
    const chevron = header.createSpan({ cls: "recent-edits-chevron" });
    setIcon(chevron, "chevron-down");
    header.createSpan({
      cls: "recent-edits-day-label",
      text: formatDayLabel(g.date),
    });

    if (withBgToggle) {
      const toggle = header.createSpan({ cls: "recent-edits-bg-toggle" });
      if (this.showBackgroundFolders) toggle.addClass("is-active");
      const iconEl = toggle.createSpan({
        cls: "recent-edits-bg-toggle-icon",
      });
      setIcon(iconEl, "archive");
      toggle.createSpan({
        cls: "recent-edits-bg-toggle-label",
        text: this.showBackgroundFolders ? "Less" : "More",
      });
      toggle.setAttribute(
        "aria-label",
        this.showBackgroundFolders
          ? "Hide background folders"
          : "Show background folders"
      );
      toggle.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.showBackgroundFolders = !this.showBackgroundFolders;
        this.render();
      });
    }

    header.createSpan({
      cls: "recent-edits-day-count",
      text: String(g.files.length),
    });
    if (isFirst) this.renderControls(header);
    header.addEventListener("click", () => {
      if (this.collapsedDays.has(g.key)) this.collapsedDays.delete(g.key);
      else this.collapsedDays.add(g.key);
      if (isCollapsed()) groupEl.dataset.collapsed = "true";
      else delete groupEl.dataset.collapsed;
    });

    const filesEl = groupEl.createDiv({ cls: "recent-edits-day-files" });
    for (const f of g.files) {
      this.renderFileRow(filesEl, f);
    }
  }

  private renderFileRow(parent: HTMLElement, file: TFile) {
    const row = parent.createDiv({ cls: "recent-edits-row" });
    if (this.plugin.isExternalEdit(file)) {
      row.addClass("is-external-edit");
    }

    const info = row.createDiv({ cls: "recent-edits-row-info" });
    const nameLine = info.createDiv({ cls: "recent-edits-row-nameline" });
    const name = nameLine.createDiv({
      cls: "recent-edits-row-name",
      text: file.basename,
    });
    name.setAttribute("title", file.path);
    if (this.plugin.settings.showSizeIndicator) {
      const dir = this.plugin.sizeDelta(file);
      if (dir) {
        const sizeEl = nameLine.createSpan({
          cls: `recent-edits-size-delta is-${dir}`,
          attr: {
            "aria-label":
              dir === "up"
                ? "Larger than previous edit"
                : "Smaller than previous edit",
          },
        });
        setIcon(sizeEl, dir === "up" ? "chevron-up" : "chevron-down");
      }
    }

    const folderPath = file.parent ? file.parent.path : "";
    const displayPath =
      folderPath === "" || folderPath === "/" ? "/" : folderPath + "/";
    const pathEl = info.createDiv({
      cls: "recent-edits-row-path",
      text: displayPath,
    });

    // The absolute-path copy only works on desktop (FileSystemAdapter), so
    // don't render a dead affordance on mobile.
    const affordance = this.plugin.settings.pathCopyAffordance;
    const canCopyAbsolute = Platform.isDesktopApp;
    const showButton =
      canCopyAbsolute && (affordance === "button" || affordance === "both");
    const pathTextIsCopyTarget =
      canCopyAbsolute && (affordance === "path-text" || affordance === "both");

    const copyAbsolutePath = async (evt: Event) => {
      evt.stopPropagation();
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        const fullPath = adapter.getFullPath(file.path);
        try {
          await navigator.clipboard.writeText(fullPath);
          new Notice("Path copied");
        } catch {
          new Notice("Copy failed");
        }
      } else {
        new Notice("Absolute path unavailable on this platform");
      }
    };

    if (pathTextIsCopyTarget) {
      pathEl.addClass("is-copy-target");
      pathEl.setAttribute("aria-label", "Click to copy absolute path");
      pathEl.addEventListener("click", (evt) => { void copyAbsolutePath(evt); });
    }

    const meta = row.createDiv({ cls: "recent-edits-row-meta" });
    if (showButton) {
      meta.addClass("has-button");
      const btn = meta.createDiv({
        cls: "recent-edits-row-copy-btn",
        attr: {
          role: "button",
          tabindex: "0",
          "aria-label": "Copy absolute path",
        },
      });
      setIcon(btn, "link");
      btn.addEventListener("click", (evt) => { void copyAbsolutePath(evt); });
      btn.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          void copyAbsolutePath(evt);
        }
      });
    }
    meta.createSpan({
      cls: "recent-edits-row-time",
      text: formatTime12h(new Date(this.plugin.effectiveMtime(file))),
    });

    row.addEventListener("click", (evt) => {
      const forceNewTab = evt.metaKey || evt.ctrlKey;
      if (!forceNewTab) {
        const existing = this.findLeafForFile(file);
        if (existing) {
          this.app.workspace.setActiveLeaf(existing, { focus: true });
          return;
        }
      }
      void this.openInNewTab(file);
    });

    row.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      this.showFileMenu(evt, file);
    });

    if (this.plugin.settings.enableHoverPreview) {
      row.addEventListener("mouseover", (evt) => {
        this.app.workspace.trigger("hover-link", {
          event: evt,
          source: HOVER_SOURCE,
          hoverParent: this,
          targetEl: row,
          linktext: file.path,
        });
      });
    }
  }
}

class RecentEditsSettingTab extends PluginSettingTab {
  plugin: RecentEditsPlugin;

  constructor(app: App, plugin: RecentEditsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("recent-edits-settings");

    new Setting(containerEl)
      .setName("Lookback days")
      .setDesc("How many days back to show. Range: 1 to 90.")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.lookbackDays))
          .onChange(async (val) => {
            const n = parseInt(val, 10);
            if (!isNaN(n) && n >= 1 && n <= 90) {
              this.plugin.settings.lookbackDays = n;
              await this.plugin.saveSettings();
            }
          });
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "90";
        // Clamp empty or out-of-range input on blur and re-sync the field so
        // the displayed value never diverges from the persisted one.
        text.inputEl.addEventListener("blur", () => {
          const n = parseInt(text.inputEl.value, 10);
          const clamped = isNaN(n)
            ? this.plugin.settings.lookbackDays
            : Math.min(90, Math.max(1, n));
          if (clamped !== this.plugin.settings.lookbackDays) {
            this.plugin.settings.lookbackDays = clamped;
            void this.plugin.saveSettings();
          }
          text.setValue(String(this.plugin.settings.lookbackDays));
        });
      });

    new Setting(containerEl)
      .setName("Hover preview")
      .setDesc(
        "Show Obsidian's page preview popup when hovering an entry. Requires the Page Preview core plugin."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableHoverPreview)
          .onChange(async (val) => {
            this.plugin.settings.enableHoverPreview = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("External edit indicator color")
      .setDesc(
        "Color of the dot shown next to files edited from outside Obsidian (filesystem writes, sync, plugins). Default is Anthropic orange."
      )
      .addColorPicker((picker) =>
        picker
          .setValue(this.plugin.settings.externalEditColor)
          .onChange(async (val) => {
            this.plugin.settings.externalEditColor = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("File size change indicator")
      .setDesc(
        "Show a subtle up/down chevron on each row indicating whether the file grew (green) or shrank (red) since its previous edit."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSizeIndicator)
          .onChange(async (val) => {
            this.plugin.settings.showSizeIndicator = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Size change threshold (KB)")
      .setDesc(
        "Minimum change, in KB, for a row to show the up/down indicator. Smaller changes are ignored. Recommended: 10."
      )
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.sizeDeltaThresholdKb))
          .onChange(async (val) => {
            const n = parseFloat(val);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.sizeDeltaThresholdKb = n;
              await this.plugin.saveSettings();
            }
          });
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        // Clamp invalid/negative input on blur and re-sync the field.
        text.inputEl.addEventListener("blur", () => {
          const n = parseFloat(text.inputEl.value);
          const clamped =
            isNaN(n) || n < 0
              ? this.plugin.settings.sizeDeltaThresholdKb
              : n;
          if (clamped !== this.plugin.settings.sizeDeltaThresholdKb) {
            this.plugin.settings.sizeDeltaThresholdKb = clamped;
            void this.plugin.saveSettings();
          }
          text.setValue(String(this.plugin.settings.sizeDeltaThresholdKb));
        });
      });

    new Setting(containerEl)
      .setName("Copy absolute path affordance")
      .setDesc(
        "How to expose the 'copy absolute path to clipboard' action on each row. The button is an explicit, always-visible target; the folder-path text is a subtler invisible affordance. Use Both to expose both."
      )
      .addDropdown((dd) =>
        dd
          .addOption("button", "Button above the time")
          .addOption("path-text", "Folder-path text")
          .addOption("both", "Both")
          .setValue(this.plugin.settings.pathCopyAffordance)
          .onChange(async (val) => {
            this.plugin.settings.pathCopyAffordance =
              val as PathCopyAffordance;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Filtering").setHeading();

    this.addFolderListSetting(containerEl, {
      name: "Background folders",
      desc: "Folders hidden by default. Use the toggle in the panel header to show them temporarily. Useful for files that update often but you only check occasionally.",
      getValue: () => this.plugin.settings.backgroundFolders,
      setValue: async (v) => {
        this.plugin.settings.backgroundFolders = v;
        await this.plugin.saveSettings();
      },
      placeholder: "Type a folder path…",
      datalistId: "recent-edits-background-folder-list",
    });

    this.addFolderListSetting(containerEl, {
      name: "Excluded folders",
      desc: `Folders hidden from the list completely. Dot-prefixed folders (${this.app.vault.configDir}, .trash) are always excluded.`,
      getValue: () => this.plugin.settings.excludedFolders,
      setValue: async (v) => {
        this.plugin.settings.excludedFolders = v;
        await this.plugin.saveSettings();
      },
      placeholder: "Type a folder path…",
      datalistId: "recent-edits-excluded-folder-list",
    });
  }

  private addFolderListSetting(
    containerEl: HTMLElement,
    opts: {
      name: string;
      desc: string;
      getValue: () => string[];
      setValue: (v: string[]) => Promise<void>;
      placeholder: string;
      datalistId: string;
    }
  ): void {
    new Setting(containerEl).setName(opts.name).setDesc(opts.desc);

    const wrapper = containerEl.createDiv({
      cls: "recent-edits-folder-list",
    });

    const chipContainer = wrapper.createDiv({
      cls: "recent-edits-chip-container",
    });

    const renderChips = () => {
      chipContainer.empty();
      const values = opts.getValue();
      if (values.length === 0) {
        chipContainer.createSpan({
          cls: "recent-edits-chip-empty",
          text: "None.",
        });
        return;
      }
      for (const folder of values) {
        const chip = chipContainer.createSpan({ cls: "recent-edits-chip" });
        chip.createSpan({
          cls: "recent-edits-chip-label",
          text: folder,
        });
        const x = chip.createSpan({
          cls: "recent-edits-chip-x",
          text: "×",
        });
        x.setAttribute("aria-label", `Remove ${folder}`);
        x.addEventListener("click", () => {
          void opts.setValue(opts.getValue().filter((f) => f !== folder)).then(() => renderChips());
        });
      }
    };
    renderChips();

    const inputWrapper = wrapper.createDiv({
      cls: "recent-edits-folder-input-wrapper",
    });
    const input = inputWrapper.createEl("input", {
      type: "text",
      cls: "recent-edits-folder-input",
      attr: { placeholder: opts.placeholder },
    });

    const datalist = inputWrapper.createEl("datalist", {
      attr: { id: opts.datalistId },
    });
    input.setAttribute("list", opts.datalistId);

    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => f.path)
      .filter((p) => p && p !== "/")
      .sort();
    for (const path of folders) {
      datalist.createEl("option", { value: path });
    }

    const addBtn = inputWrapper.createEl("button", {
      cls: "recent-edits-add-btn mod-cta",
      text: "Add",
    });
    const addCurrent = async () => {
      const trimmed = input.value.trim();
      if (!trimmed) return;
      const val = normalizePath(trimmed).replace(/^\/+/, "");
      if (!val || val === "/") return;
      if (!opts.getValue().includes(val)) {
        await opts.setValue([...opts.getValue(), val]);
        renderChips();
      }
      input.value = "";
      input.focus();
    };
    addBtn.addEventListener("click", () => { void addCurrent(); });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void addCurrent();
      }
    });
  }
}

function formatDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDayLabel(d: Date): string {
  const today = startOfLocalDay(new Date());
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${formatDayKey(d)} (${weekday})`;
}

function formatTime12h(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function dayModeIcon(mode: DayOpenMode): string {
  switch (mode) {
    case "open":
      return "chevrons-up-down";
    case "collapsed":
      return "chevrons-down-up";
    case "hover":
      return "eye";
  }
}

function dayModeLabel(mode: DayOpenMode): string {
  switch (mode) {
    case "open":
      return "Days: expanded. Click to collapse by default.";
    case "collapsed":
      return "Days: collapsed. Click to reveal on hover.";
    case "hover":
      return "Days: reveal on hover. Click to expand.";
  }
}

class RenameFileModal extends Modal {
  private file: TFile;

  constructor(app: App, file: TFile) {
    super(app);
    this.file = file;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Rename file");

    contentEl.createEl("p", {
      cls: "recent-edits-modal-current",
      text: this.file.path,
    });

    const inputEl = contentEl.createEl("input", {
      type: "text",
      cls: "recent-edits-modal-input",
    });
    inputEl.value = this.file.basename;

    const buttonRow = contentEl.createDiv({ cls: "recent-edits-modal-buttons" });
    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    const renameBtn = buttonRow.createEl("button", {
      cls: "mod-cta",
      text: "Rename",
    });

    const submit = async () => {
      const newName = inputEl.value.trim();
      if (!newName || newName === this.file.basename) {
        this.close();
        return;
      }
      const parentPath = this.file.parent?.path ?? "";
      const parentPrefix =
        parentPath && parentPath !== "/" ? `${parentPath}/` : "";
      const newPath = normalizePath(
        `${parentPrefix}${newName}.${this.file.extension}`
      );
      await this.app.fileManager.renameFile(this.file, newPath);
      this.close();
    };

    renameBtn.addEventListener("click", () => { void submit(); });
    cancelBtn.addEventListener("click", () => this.close());
    inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void submit();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        this.close();
      }
    });

    window.setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmDeleteModal extends Modal {
  private file: TFile;

  constructor(app: App, file: TFile) {
    super(app);
    this.file = file;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Delete file");

    contentEl.createEl("p", {
      text: `Delete "${this.file.path}"?`,
    });
    contentEl.createEl("p", {
      cls: "recent-edits-modal-note",
      text: "This follows your Files & Links deleted-file preference (system trash, .trash folder, or permanent delete).",
    });

    const buttonRow = contentEl.createDiv({ cls: "recent-edits-modal-buttons" });
    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    const deleteBtn = buttonRow.createEl("button", {
      cls: "mod-warning",
      text: "Delete",
    });

    deleteBtn.addEventListener("click", () => {
      void this.app.fileManager.trashFile(this.file).then(() => this.close());
    });
    cancelBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

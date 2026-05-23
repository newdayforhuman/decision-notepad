const STORAGE_KEY = "decisionNotepad.v2";
const LEGACY_STORAGE_KEY = "reasoningNotepad.prototype.v1";

// ---- Storage adapter ----------------------------------------------------
//
// Single seam between app state and the persistence mechanism. Today it
// wraps localStorage. On Tauri day, the three methods below get swapped to
// use the OS filesystem (tauri-plugin-fs) — and nothing else in the app
// needs to change.
//
// Design notes:
// - `read` and `write` stay synchronous to avoid sprinkling `await` across
//   every save site. On Tauri, the implementation will load the file into
//   an in-memory cache at bootstrap, then `read`/`write` operate on the
//   cache while a fire-and-forget queue serializes the actual disk writes.
// - `bootstrap()` is the one async hook. Today it's a no-op; on Tauri it's
//   where the initial file-read happens before the rest of the app boots.
// - Keys are namespaced strings so the same adapter could back multiple
//   stores (current session, preferences, future per-notepad files, etc.).
// In Tauri, we persist the v2 session to a JSON file at:
//   <Data>/<bundle-id>/data.json
// which is also what Tauri exposes as:
//   <AppData>/data.json
// where <AppData> is the OS-appropriate per-app directory:
//   macOS:   ~/Library/Application Support/<bundle-id>/
//   Windows: %APPDATA%\<bundle-id>\
//   Linux:   ~/.config/<bundle-id>/
//
// Tauri 2.11 currently fails to bootstrap a missing AppData parent when
// mkdir is called with `path: "."` and `baseDir: AppData` on macOS. So
// bootstrap creates the bundle-id directory under BaseDirectory.Data first,
// then reads/writes the file through BaseDirectory.AppData.
// We also keep writing to localStorage as a safety backup, so if the file
// becomes corrupt or unavailable we can still recover the user's data.
//
// File I/O is async, but the rest of the app uses sync read/write. So
// bootstrap reads the file ONCE into an in-memory cache; subsequent reads
// hit the cache (sync), and writes update the cache (sync) plus a queued
// async file write (serialized via a promise chain so writes can't race).
const STORAGE_FILE = "data.json";
const APP_DATA_DIR = "app.decisionnotepad"; // Keep in sync with tauri.conf.json identifier.
const DATA_BASE_DIR = 4; // BaseDirectory.Data
const APPDATA_BASE_DIR = 14; // BaseDirectory.AppData

let tauriInvoke = null;        // resolved during bootstrap, null in browser mode
let storageCache = null;       // string contents of data.json, or null if not loaded
let storageCacheLoaded = false;
let storageWriteQueue = Promise.resolve();

const storage = {
  async bootstrap() {
    // Detect Tauri and capture invoke for later use. Stays null in browser.
    if (typeof window === "undefined") return;
    const inv =
      window.__TAURI__?.core?.invoke ||
      window.__TAURI_INTERNALS__?.invoke ||
      window.__TAURI__?.invoke ||
      null;
    if (!inv) return;
    tauriInvoke = inv;

    try {
      // Ensure the AppData directory exists. Creating "." under AppData can
      // fail when the app-specific parent is missing, so create the bundle-id
      // folder under Data first. Confirmed in Tauri devtools:
      // mkdir("app.decisionnotepad", { baseDir: Data, recursive: true }).
      try {
        await tauriInvoke("plugin:fs|mkdir", {
          path: APP_DATA_DIR,
          options: { baseDir: DATA_BASE_DIR, recursive: true },
        });
      } catch (err) {
        console.warn("storage: could not create app data directory", err);
      }

      const exists = await tauriInvoke("plugin:fs|exists", {
        path: STORAGE_FILE,
        options: { baseDir: APPDATA_BASE_DIR },
      });

      if (exists) {
        // read_text_file returns ArrayBuffer or number[] (binary); decode.
        const raw = await tauriInvoke("plugin:fs|read_text_file", {
          path: STORAGE_FILE,
          options: { baseDir: APPDATA_BASE_DIR },
        });
        const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
        const text = new TextDecoder().decode(bytes);
        // Validate it parses as JSON before trusting it. If parse fails the
        // file is corrupt; leave storageCache null and we'll fall back to
        // localStorage on read, which gets us the last good safety backup.
        try {
          JSON.parse(text);
          storageCache = text;
        } catch (err) {
          console.warn("storage: data.json is invalid JSON, falling back to localStorage", err);
        }
      }
    } catch (err) {
      console.warn("storage.bootstrap failed", err);
    } finally {
      storageCacheLoaded = true;
    }
  },

  read(key) {
    if (key === STORAGE_KEY && tauriInvoke && storageCacheLoaded && storageCache !== null) {
      return storageCache;
    }
    // Browser mode, OR Tauri with no file yet, OR Tauri with corrupt file.
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  write(key, value) {
    // Always write to localStorage — cheap and provides the recovery path
    // if the file write fails or the file gets corrupted later.
    try { localStorage.setItem(key, value); } catch (err) {
      console.warn(`storage.write(${key}) failed`, err);
    }
    if (key === STORAGE_KEY && tauriInvoke && storageCacheLoaded) {
      storageCache = value;
      queueStorageFileWrite();
    }
  },
};

// Serialized file writes — each call appends to the chain so writes can't
// race. Each enqueued task reads the LATEST storageCache at execution
// time, so rapid-fire writes (e.g. per-keystroke during inline edit) all
// converge to the latest state without piling up wasted work.
function queueStorageFileWrite() {
  storageWriteQueue = storageWriteQueue.then(async () => {
    if (storageCache === null) return;
    try {
      const body = new TextEncoder().encode(storageCache);
      await tauriInvoke("plugin:fs|write_text_file", body, {
        headers: {
          path: encodeURIComponent(STORAGE_FILE),
          options: JSON.stringify({ baseDir: APPDATA_BASE_DIR }),
        },
      });
    } catch (err) {
      console.warn("storage file write failed", err);
    }
  });
}

// ---- Undo / redo --------------------------------------------------------
//
// Per-commit, session-only, capped history. Snapshots are JSON-serialized
// subsets of state.session — only the fields users would expect to undo:
// entries (covers create/delete/marker/reorder/text edits) and scratchPad.
// Settings, label customization, filter, view state are intentionally NOT
// snapshotted (per the minimum-viable scope agreed in design).
//
// Two snapshot entry points:
//   - `withUndo(fn)` for discrete actions (create/delete/marker/reorder).
//     Captures before, runs, pushes if state changed.
//   - `beginEditSession()` / `commitEditSession()` for text edit sessions.
//     beginEditSession is called on focusin of a tracked field;
//     commitEditSession on focusout. One snapshot per focus-to-blur span,
//     pushed only if something actually changed.
//
// Mod+Z and Mod+Shift+Z are wired into the SHORTCUTS table and fire from
// any focus context so users can undo while still inside a text field.

const UNDO_MAX = 50;
const UNDO_TRACKED_SELECTOR = [
  "#scratchPadText",
  "#detailTitleInput",
  "#detailBodyInput",
  "#detailSourceInput",
  "#notesViewTitle",
  "#notesViewBody",
  "#notesViewSource",
  ".inline-title-input",
  ".inline-body-input",
  ".inline-source-input",
].join(", ");

const undoState = {
  stack: [],
  redoStack: [],
  pending: null,   // snapshot captured on focusin, pushed on focusout if dirty
};

function captureSnapshot() {
  return JSON.stringify({
    entries: state.session.entries,
    scratchPad: state.session.scratchPad || "",
  });
}

function restoreSnapshot(snap) {
  const parsed = JSON.parse(snap);
  state.session.entries = parsed.entries;
  state.session.scratchPad = parsed.scratchPad;
  // If the currently-selected entry no longer exists (e.g. we just undid a
  // create), drop the selection so renders don't reach for a ghost id.
  if (state.selectedId && !state.session.entries.some((e) => e.id === state.selectedId)) {
    state.selectedId = null;
    state.session.preferences.selectedId = "";
  }
  // Editing in-place during an undo is undefined behavior; just exit.
  state.editingRowId = null;
  saveSession();
  renderAll();
  // renderAll doesn't touch notes view; refresh it if it's open.
  if (state.notesViewOpen) renderNotesView();
}

function pushUndo(snap) {
  undoState.stack.push(snap);
  if (undoState.stack.length > UNDO_MAX) undoState.stack.shift();
  undoState.redoStack = []; // any new action invalidates the redo branch
}

// Wrap a mutation. Capture before, run, push only if something actually
// changed. Use for discrete actions where one user gesture = one undo step.
function withUndo(fn) {
  const before = captureSnapshot();
  fn();
  const after = captureSnapshot();
  if (before !== after) pushUndo(before);
}

// Text edit sessions: one snapshot per focus-to-blur span on tracked fields.
function beginEditSession() {
  if (undoState.pending !== null) return; // already in a session
  undoState.pending = captureSnapshot();
}

function commitEditSession() {
  if (undoState.pending === null) return;
  const pending = undoState.pending;
  undoState.pending = null;
  const current = captureSnapshot();
  if (current !== pending) pushUndo(pending);
}

function undo() {
  // If we're mid-edit, commit that session first so its snapshot is on the
  // stack before we pop. Without this, Mod+Z inside an active field would
  // skip over the user's most recent edits.
  commitEditSession();
  if (!undoState.stack.length) return;
  const current = captureSnapshot();
  const prev = undoState.stack.pop();
  undoState.redoStack.push(current);
  restoreSnapshot(prev);
  restoreFocusToSelectedRow();
}

function redo() {
  commitEditSession();
  if (!undoState.redoStack.length) return;
  const current = captureSnapshot();
  const next = undoState.redoStack.pop();
  undoState.stack.push(current);
  restoreSnapshot(next);
  restoreFocusToSelectedRow();
}

const MARKERS = [
  { id: "keep",     label: "Keep",     glyph: "K" },
  { id: "reject",   label: "Reject",   glyph: "R" },
  { id: "question", label: "Question", glyph: "?" },
  { id: "verify",   label: "Verify",   glyph: "V" },
];

const MARKER_BY_ID = Object.fromEntries(MARKERS.map((m) => [m.id, m]));

// Four marker labels, eight readable color choices.
// Color values live in tokens.css; JS stores semantic ids only.
const COLOR_PALETTE = [
  { id: "green",  solid: "var(--marker-green-text)",  tint: "var(--marker-green-fill)" },
  { id: "orange", solid: "var(--marker-orange-text)", tint: "var(--marker-orange-fill)" },
  { id: "yellow", solid: "var(--marker-yellow-text)", tint: "var(--marker-yellow-fill)" },
  { id: "blue",   solid: "var(--marker-blue-text)",   tint: "var(--marker-blue-fill)" },
  { id: "purple", solid: "var(--marker-purple-text)", tint: "var(--marker-purple-fill)" },
  { id: "teal",   solid: "var(--marker-teal-text)",   tint: "var(--marker-teal-fill)" },
  { id: "gray",   solid: "var(--marker-gray-text)",   tint: "var(--marker-gray-fill)" },
  { id: "red",    solid: "var(--marker-red-text)",    tint: "var(--marker-red-fill)" },
];

const PALETTE_BY_ID = Object.fromEntries(COLOR_PALETTE.map((c) => [c.id, c]));

// Default color assignment for each marker (id of a palette entry).
const DEFAULT_MARKER_COLOR = {
  keep: "green", reject: "orange", question: "yellow", verify: "blue",
};

const LEGACY_COLOR_ID_MAP = {
  moss: "green",
  rust: "orange",
  ochre: "yellow",
  slate: "blue",
  plum: "purple",
  rose: "red",
};

const AI_GUARDRAILS = "These are rough first-impression notes from Reasoning Notepad. They may contain uncertainty, incomplete facts, and early judgments. Do not treat them as final conclusions. Do not invent facts. Preserve the user's judgments. Separate user-written notes from your suggestions. Point out gaps, contradictions, unsupported claims, and unclear reasoning.";

const AI_PRESETS = {
  none: {
    instruction: "",
    description: "No preset text is added. Use your own prompt before or after the copied notes.",
  },
  gaps: {
    instruction: "Find gaps, weak reasoning, contradictions, unsupported claims, unclear reasoning, and places where more evidence would help. Do not make the decision for the user.",
    description: "Looks for weak spots, missing support, contradictions, and unclear reasoning.",
  },
  summarize: {
    instruction: "Summarize these notes while preserving uncertainty, open questions, and the user's current judgments.",
    description: "Condenses the notes without making them sound more final than they are.",
  },
  challenge: {
    instruction: "Challenge the reasoning. Identify counterarguments, assumptions, weak spots, and places where the user's current judgment may be premature.",
    description: "Asks the AI to push back and look for counterarguments or premature conclusions.",
  },
  cleaner: {
    instruction: "Turn these notes into cleaner wording without making them sound more final or more confident than they are.",
    description: "Rewrites rough notes more clearly while preserving your uncertainty.",
  },
  questions: {
    instruction: "Create follow-up questions that would help clarify uncertainty, verify facts, and strengthen or challenge the user's current judgments.",
    description: "Generates questions to check facts, references, and unresolved issues.",
  },
};

const state = {
  session: null,
  filter: "All",
  search: "",
  selectedId: null,
  detailOpen: false,
  notesViewOpen: false,
  editingRowId: null,
  markerMenuId: null,
  aiReviewDirty: false,
};

const el = {};

document.addEventListener("DOMContentLoaded", async () => {
  // Mark the host as Tauri (vs browser) so CSS can adapt. The card-on-page
  // aesthetic was designed for browser tabs; in a native window the OS
  // frame already provides the chrome, so the app fills the window edge-
  // to-edge instead.
  //
  // Detection: __TAURI_INTERNALS__ is always injected by Tauri 2,
  // regardless of the `withGlobalTauri` config flag. __TAURI__ is only
  // injected when that flag is true (which we use for the menu bridge).
  // Checking both means CSS adapts even if the config flag is off, and
  // the protocol check catches the rare edge where neither global is
  // populated yet (very early frame on cold start).
  if (typeof window !== "undefined") {
    const isTauri = Boolean(
      window.__TAURI__ ||
      window.__TAURI_INTERNALS__ ||
      (location.protocol && location.protocol.startsWith("tauri"))
    );
    if (isTauri) document.documentElement.classList.add("tauri-host");
  }
  bindElements();
  await storage.bootstrap();
  state.session = loadSession();
  applyThemePreference();
  applyMarkerColors();
  if (state.session.preferences.selectedId) {
    const exists = state.session.entries.some((e) => e.id === state.session.preferences.selectedId);
    if (exists) state.selectedId = state.session.preferences.selectedId;
  }
  renderAll();
  applySidebarVisibility();
  bindEvents();
  bindTauriMenuEvents();
  applyWindowPreferences();
});

// ---- Tauri bridge ------------------------------------------------------
//
// When running inside the Tauri shell, the native menu emits "menu-event"
// with the clicked item's id (e.g. "undo", "toggle_cheatsheet"). We route
// each id to the existing in-app handler — keeps the menu as a thin
// click-affordance over the same code paths the keyboard uses.
//
// Falls through cleanly in the browser (`window.__TAURI__` is undefined),
// so this file stays single-source for both targets.

function bindTauriMenuEvents() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!tauri?.event?.listen) return;

  tauri.event.listen("menu-event", ({ payload }) => {
    switch (payload) {
      case "undo":              undo(); break;
      case "redo":              redo(); break;
      case "toggle_timestamps": toggleShowTimestampsFromMenu(); break;
      case "toggle_cheatsheet": toggleCheatsheet(); break;
      case "toggle_scratch":    toggleScratchPad(); break;
      case "toggle_sidebar":    toggleSidebar(); break;
      case "toggle_pin":        toggleWindowPin(); break;
      case "open_settings":     openSettings(); break;
      case "new_entry":         el.captureInput?.focus(); break;
      case "export_markdown":   downloadMarkdown(); break;
      case "export_json":       exportJSON(); break;
      default:                  console.warn("Unhandled menu event:", payload);
    }
  });
}

// Mirror the in-app Settings toggle for the View > Show Timestamps menu
// item. Keeps a single source of truth — the checkbox in Settings — and
// re-renders so the timestamps appear/disappear immediately.
function toggleShowTimestampsFromMenu() {
  if (!state.session.preferences) return;
  state.session.preferences.showTimestamps = !state.session.preferences.showTimestamps;
  if (el.showTimestampsInput) el.showTimestampsInput.checked = state.session.preferences.showTimestamps;
  saveSession();
  renderAll();
  if (state.notesViewOpen) renderNotesView();
}

// Sidebar visibility — collapses the left rail entirely, giving the entry
// list and detail panel the freed ~220px. Used when the window is narrow
// or when the user wants to focus on a single entry. State persists across
// reloads via preferences.sidebarHidden.
function toggleSidebar() {
  if (!state.session.preferences) return;
  state.session.preferences.sidebarHidden = !state.session.preferences.sidebarHidden;
  applySidebarVisibility();
  saveSession();
}

function applySidebarVisibility() {
  const hidden = Boolean(state.session?.preferences?.sidebarHidden);
  const shell = document.getElementById("appShell");
  if (shell) shell.classList.toggle("sidebar-hidden", hidden);

  // The footer button and the View menu item both need their label to
  // reflect the current state so they read accurately in either direction.
  const label = hidden ? "Show Sidebar" : "Hide Sidebar";
  if (el.sidebarToggleBtn) {
    el.sidebarToggleBtn.setAttribute("aria-label", label);
    el.sidebarToggleBtn.title = label;
  }
  updateSidebarMenuLabel(label);
}

// Position an anchored popover above its trigger button. The popover is
// floating (position: fixed) and sized to ~360px wide; we just compute
// where its bottom-right corner should sit relative to the anchor's
// top-right corner, and cap its max-height to the available space above.
//
// Called by openExport / openLabelEditor / openSettings each time they
// open, since the anchor's screen position can change (window resize,
// sidebar hide/show, etc.).
function positionAnchoredPopover(popoverEl, anchorEl) {
  if (!popoverEl || !anchorEl) return;
  const anchor = anchorEl.getBoundingClientRect();
  const gap = 8;        // px gap between anchor and popover
  const margin = 8;     // min px from viewport edge
  // Right-align popover with anchor's right edge, but keep it on screen.
  const rightOffset = Math.max(margin, window.innerWidth - anchor.right);
  popoverEl.style.right = rightOffset + "px";
  popoverEl.style.left = "auto";
  popoverEl.style.top = "auto";
  // Float popover above the anchor.
  popoverEl.style.bottom = (window.innerHeight - anchor.top + gap) + "px";
  // Cap height to the space above the anchor minus a comfort margin.
  popoverEl.style.maxHeight = Math.max(120, anchor.top - margin * 2) + "px";
}

// Tauri-only: tell the Rust side to relabel the View > Hide/Show Sidebar
// menu item. macOS menus don't natively bind to JS state, so we update
// via an invoke into a custom Rust command (defined in lib.rs).
function updateSidebarMenuLabel(label) {
  if (typeof window === "undefined") return;
  const invoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;
  if (!invoke) return; // browser mode, no menu to update
  invoke("set_menu_item_label", { id: "toggle_sidebar", label }).catch(() => {});
}

function isTauriRuntime() {
  return Boolean(
    typeof window !== "undefined" && (
      window.__TAURI__ ||
      window.__TAURI_INTERNALS__ ||
      (location.protocol && location.protocol.startsWith("tauri"))
    )
  );
}

function currentTauriWindow() {
  return window.__TAURI__?.window?.getCurrentWindow?.() || null;
}

function setPinButtonState(enabled) {
  if (!el.pinBtn) return;
  el.pinBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
  el.pinBtn.classList.toggle("active", enabled);
  el.pinBtn.setAttribute("aria-label", enabled ? "Unpin window" : "Pin window above other apps");
  el.pinBtn.title = `${enabled ? "Unpin window" : "Pin window above other apps"} (${renderCheatsheetKey("Mod+Shift+P")})`;
  if (el.alwaysOnTopInput) el.alwaysOnTopInput.checked = enabled;
}

async function applyWindowPreferences() {
  const enabled = Boolean(state.session?.preferences?.alwaysOnTop);
  setPinButtonState(enabled);
  if (isTauriRuntime() && enabled) {
    await setWindowAlwaysOnTop(true, { persist: false, silent: true });
  }
}

async function toggleWindowPin() {
  const next = !Boolean(state.session?.preferences?.alwaysOnTop);
  await setWindowAlwaysOnTop(next);
}

async function setWindowAlwaysOnTop(enabled, { persist = true, silent = false } = {}) {
  const appWindow = currentTauriWindow();
  if (!appWindow?.setAlwaysOnTop) {
    setPinButtonState(false);
    if (!silent) setExportStatus("Pin window is available in the Tauri app.", "error");
    return false;
  }

  try {
    await appWindow.setAlwaysOnTop(enabled);
    if (persist && state.session?.preferences) {
      state.session.preferences.alwaysOnTop = enabled;
      saveSession();
    }
    setPinButtonState(enabled);
    if (!silent) {
      setExportStatus(enabled ? "Window pinned above other apps." : "Window pin off.");
    }
    return true;
  } catch (err) {
    console.warn("Could not set always-on-top", err);
    setPinButtonState(!enabled);
    if (!silent) setExportStatus("Could not change window pin.", "error");
    return false;
  }
}

// ---- Element binding ----

function bindElements() {
  [
    "sessionTitle", "searchInput", "impressionFilters", "propertyFilters",
    "legendBtn", "legendPopover", "closeLegendBtn", "legendTableBody",
    "sidebarToggleBtn",
    "labelEditorBtn", "labelEditor", "closeLabelEditorBtn", "labelEditorRows", "resetLabelsBtn",
    "goalBtn", "goalPreview", "goalEditor", "closeGoalEditorBtn", "goalText",
    "settingsBtn", "settingsPopover", "closeSettingsBtn", "themeSelect", "showTimestampsInput", "alwaysOnTopInput", "settingsBackupBtn", "settingsOpenBackupBtn", "openDataFolderBtn",
    "exportBtn", "exportPopover", "closeExportBtn", "exportJsonBtn", "jsonRestoreBtn", "jsonRestoreInput", "exportMarkdownBtn", "exportMarkdownDownloadBtn", "aiReviewBtn", "aiReviewPanel", "closeAiReviewBtn", "aiPresetSelect", "aiPresetDescription", "aiGuardrailsInput", "aiCustomInstructions", "aiReviewPreview", "regenerateAiReviewBtn", "copyAiReviewBtn", "exportStatus",
    "captureInput", "scratchPadBtn", "pinBtn",
    "entryList",
    "detailPanel", "closeDetailBtn",
    "detailPanelTitle", "detailPanelStatus", "detailPanelTimestamp",
    "detailTitleInput", "detailBodyInput",
    "markerSegmented", "clearMarkerBtn",
    "detailSourceInput",
    "deleteEntryBtn", "deleteConfirm", "cancelDeleteBtn", "confirmDeleteBtn",
    "scratchPadPanel", "scratchPadText", "clearScratchPadBtn",
    "footerSummary", "footerStatus",
    "notesView", "notesViewBack", "notesViewClose", "notesViewMeta",
    "notesViewTitle", "notesViewBody", "notesViewSource",
  ].forEach((id) => {
    el[id] = document.getElementById(id);
    if (!el[id]) console.warn("Missing element:", id);
  });
}

// ---- Events ----

function bindEvents() {
  el.sessionTitle.addEventListener("input", () => {
    state.session.title = el.sessionTitle.value || "Untitled";
    saveSession();
  });

  el.searchInput.addEventListener("input", () => {
    state.search = el.searchInput.value.toLowerCase();
    renderFilters();
    renderEntries();
    renderFooter();
  });

  el.goalBtn.addEventListener("click", openGoalEditor);
  el.closeGoalEditorBtn.addEventListener("click", closeGoalEditor);
  el.goalText.addEventListener("input", () => {
    state.session.goal = el.goalText.value;
    saveSession();
    renderGoalPreview();
    state.aiReviewDirty = true;
  });

  el.legendBtn.addEventListener("click", () => {
    const opening = el.legendPopover.classList.contains("hidden");
    if (opening) renderLegend();
    el.legendPopover.classList.toggle("hidden");
    el.legendBtn.setAttribute("aria-expanded", opening ? "true" : "false");
  });
  el.closeLegendBtn.addEventListener("click", () => {
    el.legendPopover.classList.add("hidden");
    el.legendBtn.setAttribute("aria-expanded", "false");
  });

  el.exportBtn.addEventListener("click", openExport);
  el.closeExportBtn.addEventListener("click", closeExport);
  el.exportJsonBtn.addEventListener("click", exportJSON);
  el.jsonRestoreBtn.addEventListener("click", () => el.jsonRestoreInput.click());
  el.jsonRestoreInput.addEventListener("change", restoreJSONBackup);
  el.exportMarkdownBtn.addEventListener("click", exportMarkdown);
  el.exportMarkdownDownloadBtn.addEventListener("click", downloadMarkdown);
  el.aiReviewBtn.addEventListener("click", openAiReview);
  el.closeAiReviewBtn.addEventListener("click", closeAiReview);
  el.aiPresetSelect.addEventListener("change", handleAiOptionsChanged);
  el.aiGuardrailsInput.addEventListener("change", handleAiOptionsChanged);
  el.aiCustomInstructions.addEventListener("input", handleAiOptionsChanged);
  el.aiReviewPreview.addEventListener("input", () => { state.aiReviewDirty = true; });
  el.regenerateAiReviewBtn.addEventListener("click", () => renderAiReviewPreview(true));
  el.copyAiReviewBtn.addEventListener("click", copyAiReviewPreview);

  el.sidebarToggleBtn.addEventListener("click", toggleSidebar);
  el.labelEditorBtn.addEventListener("click", openLabelEditor);
  el.closeLabelEditorBtn.addEventListener("click", () => el.labelEditor.classList.add("hidden"));
  el.resetLabelsBtn.addEventListener("click", () => {
    state.session.markerCustom = defaultMarkerCustom();
    saveSession();
    applyMarkerColors();
    renderLabelEditor();
    rerenderMarkersEverywhere();
  });

  el.settingsBtn.addEventListener("click", openSettings);
  el.closeSettingsBtn.addEventListener("click", closeSettings);
  el.themeSelect.addEventListener("change", () => {
    state.session.preferences.theme = normalizeThemePreference(el.themeSelect.value);
    applyThemePreference();
    saveSession();
  });
  el.showTimestampsInput.addEventListener("change", () => {
    state.session.preferences.showTimestamps = el.showTimestampsInput.checked;
    saveSession();
    renderEntries();
    renderDetail();
    renderNotesView();
  });
  el.alwaysOnTopInput.addEventListener("change", () => {
    setWindowAlwaysOnTop(el.alwaysOnTopInput.checked);
  });
  el.settingsBackupBtn.addEventListener("click", exportJSON);
  el.settingsOpenBackupBtn.addEventListener("click", () => el.jsonRestoreInput.click());
  el.openDataFolderBtn.addEventListener("click", openAppDataFolder);

  el.captureInput.addEventListener("keydown", handleCaptureKey);

  el.scratchPadBtn.addEventListener("click", toggleScratchPad);

  el.pinBtn.addEventListener("click", toggleWindowPin);

  document.querySelectorAll("[data-close-drawer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".drawer")?.classList.add("hidden");
      el.scratchPadBtn.classList.remove("active");
    });
  });

  el.scratchPadText.addEventListener("input", () => {
    state.session.scratchPad = el.scratchPadText.value;
    saveSession();
  });

  el.clearScratchPadBtn.addEventListener("click", () => {
    state.session.scratchPad = "";
    el.scratchPadText.value = "";
    saveSession();
  });

  el.closeDetailBtn.addEventListener("click", closeDetail);

  el.detailTitleInput.addEventListener("input", () => {
    updateSelected({ title: el.detailTitleInput.value });
    el.detailPanelTitle.textContent = el.detailTitleInput.value || "Untitled entry";
    if (state.editingRowId !== state.selectedId) {
      const row = el.entryList.querySelector(`[data-id="${state.selectedId}"]`);
      if (row) refreshRowContent(row, selectedEntry());
    }
  });

  el.detailBodyInput.addEventListener("input", () => {
    updateSelected({ body: el.detailBodyInput.value });
    if (state.editingRowId !== state.selectedId) {
      const row = el.entryList.querySelector(`[data-id="${state.selectedId}"]`);
      if (row) refreshRowContent(row, selectedEntry());
    }
  });

  el.detailSourceInput.addEventListener("input", () => {
    updateSelected({ source: el.detailSourceInput.value });
    updateDetailStatus();
    refreshReferenceDependentSurfaces();
    if (state.editingRowId !== state.selectedId) {
      const row = el.entryList.querySelector(`[data-id="${state.selectedId}"]`);
      if (row) refreshRowContent(row, selectedEntry());
    }
  });

  el.deleteEntryBtn.addEventListener("click", () => {
    el.deleteConfirm.classList.remove("hidden");
    el.deleteEntryBtn.classList.add("hidden");
  });
  el.cancelDeleteBtn.addEventListener("click", () => {
    el.deleteConfirm.classList.add("hidden");
    el.deleteEntryBtn.classList.remove("hidden");
  });
  el.confirmDeleteBtn.addEventListener("click", deleteSelected);

  el.notesViewBack.addEventListener("click", closeNotesView);
  el.notesViewClose.addEventListener("click", closeNotesView);
  el.notesViewTitle.addEventListener("input", () => {
    updateSelected({ title: el.notesViewTitle.value });
    syncRowAndDetailForSelected();
  });
  el.notesViewSource.addEventListener("input", () => {
    updateSelected({ source: el.notesViewSource.value });
    syncRowAndDetailForSelected();
    renderNotesViewMeta();
    refreshReferenceDependentSurfaces();
  });
  el.notesViewBody.addEventListener("input", () => {
    updateSelected({ body: el.notesViewBody.value });
    syncRowAndDetailForSelected();
  });

  // Capture phase, not bubble. Two reasons:
  //   - We want to fire before any inner element's keydown handler, so
  //     in-app shortcuts are unambiguous.
  //   - When the user just clicked a destructive button (e.g. a marker
  //     popup option), the focused element disappears and focus can
  //     escape the page. Capture-phase still receives keydowns that
  //     reach the document, which is what we want.
  document.addEventListener("keydown", handleGlobalKey, true);
  document.addEventListener("click", handleDocClick);

  // Undo edit-session tracking. Single delegated listener so dynamic fields
  // (inline edit textareas, which are created/destroyed on demand) are
  // covered automatically. `focusin`/`focusout` bubble — `focus`/`blur` do not.
  document.addEventListener("focusin", (e) => {
    if (e.target?.matches?.(UNDO_TRACKED_SELECTOR)) beginEditSession();
  });
  document.addEventListener("focusout", (e) => {
    if (e.target?.matches?.(UNDO_TRACKED_SELECTOR)) commitEditSession();
  });

  // Drag-drop "fall-through" handlers — catch drags into empty space
  // below the last row so reordering to the end of the list works
  // even when there's a lot of empty area below.
  el.entryList.addEventListener("dragover", handleListDragOver);
  el.entryList.addEventListener("drop", handleListDrop);
}

function syncRowAndDetailForSelected() {
  const item = selectedEntry();
  if (!item) return;
  if (state.editingRowId !== state.selectedId) {
    const row = el.entryList.querySelector(`[data-id="${state.selectedId}"]`);
    if (row) refreshRowContent(row, item);
  }
  if (state.detailOpen) {
    el.detailTitleInput.value = item.title || "";
    el.detailBodyInput.value = item.body || "";
    el.detailSourceInput.value = item.source || "";
    el.detailPanelTitle.textContent = item.title || "Untitled entry";
    updateDetailStatus();
  }
}

function refreshReferenceDependentSurfaces({ renderList = true } = {}) {
  renderFilters();
  renderFooter();
  if (renderList && (state.search || state.filter === "has-source" || state.filter === "no-source")) {
    renderEntries();
  }
}

// ---- Keyboard handlers ----
//
// Source of truth for the in-window shortcut surface. See
// docs/keyboard-shortcuts.md — that doc is generated by hand from this table,
// and the in-app cheatsheet (Mod+/ or ?) is generated automatically from it.
//
// Platform note: `Mod` = Cmd on macOS, Ctrl on Windows/Linux. Matches Tauri's
// `CmdOrCtrl` accelerator. Detected once at load.

const IS_MAC = typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

function hasMod(e)       { return IS_MAC ? e.metaKey : e.ctrlKey; }
function noMod(e)        { return !e.metaKey && !e.ctrlKey; }
function noShift(e)      { return !e.shiftKey; }
function noAlt(e)        { return !e.altKey; }
function bareKey(e)      { return noMod(e) && noShift(e) && noAlt(e); }

function focusContext() {
  // Two states matter: is the user typing into an editable field, or are they
  // navigating the list? Selected rows take DOM focus (tabindex=0) but that's
  // still the navigation context — only true text fields count as "editing".
  const a = document.activeElement;
  const tag = a?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || a?.isContentEditable) return "editing";
  return "list";
}

function handleCaptureKey(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const title = el.captureInput.value.trim();
    if (!title) return;
    createEntry(title);
    el.captureInput.value = "";
  }
  if (e.key === "Escape") {
    el.captureInput.value = "";
    el.captureInput.blur();
  }
}

// Cascade Esc / Mod+W through the visible-panel stack. Returns true if a
// panel was closed. Order matters — deepest overlay first.
function closeTopPanel() {
  if (el.cheatsheetOverlay && !el.cheatsheetOverlay.classList.contains("hidden")) {
    closeCheatsheet(); return true;
  }
  if (!el.legendPopover.classList.contains("hidden")) {
    el.legendPopover.classList.add("hidden"); return true;
  }
  if (!el.labelEditor.classList.contains("hidden")) {
    el.labelEditor.classList.add("hidden"); return true;
  }
  if (!el.goalEditor.classList.contains("hidden")) {
    closeGoalEditor(); return true;
  }
  if (!el.settingsPopover.classList.contains("hidden")) {
    closeSettings(); return true;
  }
  if (state.markerMenuId) {
    closeMarkerMenu(); return true;
  }
  if (!el.exportPopover.classList.contains("hidden")) {
    closeExport(); return true;
  }
  if (!el.scratchPadPanel.classList.contains("hidden")) {
    closeScratchPad(); return true;
  }
  if (state.notesViewOpen) {
    closeNotesView(); return true;
  }
  if (state.detailOpen) {
    closeDetail(); return true;
  }
  return false;
}

// Move the selection up/down by one row in the currently-visible ordering.
function moveSelection(delta) {
  const list = orderedEntries();
  if (!list.length) return;
  const idx = list.findIndex((e) => e.id === state.selectedId);
  let next;
  if (idx === -1) {
    next = delta > 0 ? list[0] : list[list.length - 1];
  } else {
    const target = Math.max(0, Math.min(list.length - 1, idx + delta));
    next = list[target];
  }
  if (next) {
    selectRow(next.id);
    const row = el.entryList.querySelector(`[data-id="${next.id}"]`);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }
}

function editSelected() {
  if (!state.selectedId) return;
  const row = el.entryList.querySelector(`[data-id="${state.selectedId}"]`);
  const item = selectedEntry();
  if (row && item) startInlineEdit(row, item);
}

function promptDeleteSelected() {
  if (!state.selectedId) return;
  const item = selectedEntry();
  const label = item?.title ? `"${item.title}"` : "this entry";
  if (window.confirm(`Delete ${label}? This can't be undone.`)) {
    deleteSelected();
  }
}

// ---- Routing table ----
//
// Each entry: { id, group, label, keys, when?, run }
//  - keys: human-readable for the cheatsheet (e.g. "Mod+N", "1")
//  - when(e, ctx): predicate against the KeyboardEvent + focus context
//  - run(e): action; should call e.preventDefault() unless it explicitly wants
//    the browser default
//
// `when` runs only after the global "is this a typing context?" gate. Bare-key
// shortcuts are gated to ctx === "list". Mod-key shortcuts fire from any ctx
// unless `editingOK: false` is explicit (we want Mod+S to work even from a
// focused input).

const SHORTCUTS = [
  // --- App-level (Mod) ---
  { id: "new-mod",     group: "App",         label: "New entry",                  keys: ["Mod+N"],
    when: (e) => hasMod(e) && (e.key === "n" || e.key === "N") && !state.notesViewOpen,
    run:  () => el.captureInput.focus() },
  { id: "find-mod",    group: "App",         label: "Focus search",               keys: ["Mod+F"],
    when: (e) => hasMod(e) && (e.key === "f" || e.key === "F") && !state.notesViewOpen,
    run:  () => el.searchInput.focus() },
  { id: "settings",    group: "App",         label: "Toggle Settings",            keys: ["Mod+,"],
    when: (e) => hasMod(e) && e.key === ",",
    run:  () => el.settingsPopover.classList.contains("hidden") ? openSettings() : closeSettings() },
  { id: "pin-window",  group: "App",         label: "Pin window above other apps", keys: ["Mod+Shift+P"],
    when: (e) => hasMod(e) && e.shiftKey && (e.key === "p" || e.key === "P"),
    run:  () => toggleWindowPin() },
  { id: "export",      group: "App",         label: "Open Export",                keys: ["Mod+S"],
    when: (e) => hasMod(e) && (e.key === "s" || e.key === "S") && noShift(e),
    run:  () => el.exportPopover.classList.contains("hidden") ? openExport() : closeExport() },
  { id: "close-panel", group: "App",         label: "Close top panel",            keys: ["Mod+W"],
    when: (e) => hasMod(e) && (e.key === "w" || e.key === "W"),
    run:  (e) => { const closed = closeTopPanel(); if (!closed) e.preventDefault(); } },
  { id: "delete-mod",  group: "App",         label: "Delete selected entry",      keys: ["Mod+Backspace"],
    when: (e) => hasMod(e) && (e.key === "Backspace" || e.key === "Delete") && state.selectedId,
    run:  () => promptDeleteSelected() },
  // Undo / redo fire from any focus context so users can undo while still
  // inside a text field. preventDefault stops the browser's per-input undo.
  { id: "undo",        group: "App",         label: "Undo",                       keys: ["Mod+Z"],
    when: (e) => hasMod(e) && !e.shiftKey && (e.key === "z" || e.key === "Z"),
    run:  () => undo() },
  { id: "redo",        group: "App",         label: "Redo",                       keys: ["Mod+Shift+Z"],
    when: (e) => hasMod(e) && e.shiftKey && (e.key === "z" || e.key === "Z"),
    run:  () => redo() },
  { id: "cheatsheet",  group: "App",         label: "Toggle cheatsheet",          keys: ["Mod+/", "?"],
    when: (e) => (hasMod(e) && e.key === "/") || (e.key === "?" && focusContext() === "list"),
    run:  () => toggleCheatsheet() },
  // Sidebar toggle matches macOS convention (Mail/Finder/Notes all use
  // Cmd+Alt+S). Useful when the window is narrow and you want to give the
  // entry list more room. In Tauri the native menu accelerator owns the
  // key combo; this entry covers browser mode and keeps the cheatsheet
  // accurate in both.
  { id: "sidebar",     group: "App",         label: "Toggle sidebar",             keys: ["Mod+Alt+S"],
    when: (e) => hasMod(e) && e.altKey && (e.key === "s" || e.key === "S" || e.key === "ß"),
    run:  () => toggleSidebar() },
  // Reload — convenient in Tauri dev (right-click → Reload is the manual
  // alternative). Harmless in production: localStorage persists across
  // reloads so no data is lost; only ephemeral UI state (selection,
  // open panels) resets. Skipped while inside a text edit so it doesn't
  // surprise users mid-typing.
  { id: "reload",      group: "App",         label: "Reload window",              keys: ["Mod+R"],
    when: (e, ctx) => hasMod(e) && !e.shiftKey && (e.key === "r" || e.key === "R") && ctx !== "editing",
    run:  () => location.reload() },

  // --- Escape: cascade close, then deselect ---
  { id: "escape",      group: null,          label: null,                         keys: ["Esc"],
    when: (e) => e.key === "Escape",
    run:  () => {
      const closed = closeTopPanel();
      if (closed) return;
      if (state.editingRowId) { commitInlineEdit(state.editingRowId); return; }
      if (state.selectedId)   { state.selectedId = null; renderEntries(); return; }
    } },

  // --- Open / edit selected ---
  { id: "open-detail-enter", group: "Selected entry", label: "Open detail panel", keys: ["Enter"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && e.key === "Enter" && state.selectedId && !state.detailOpen && !state.notesViewOpen,
    run:  () => openDetail() },
  { id: "open-detail-mod",   group: "Selected entry", label: "Open detail panel", keys: ["Mod+Enter"],
    when: (e) => hasMod(e) && e.key === "Enter" && state.selectedId && !state.detailOpen && !state.notesViewOpen,
    run:  () => openDetail() },
  { id: "notes-view",        group: "Selected entry", label: "Open full-screen Notes view", keys: ["Shift+Enter"],
    when: (e, ctx) => ctx === "list" && e.shiftKey && noMod(e) && noAlt(e) && e.key === "Enter" && state.selectedId && !state.notesViewOpen,
    run:  () => openNotesView() },
  { id: "edit-selected",     group: "Selected entry", label: "Inline edit selected", keys: ["E"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && (e.key === "e" || e.key === "E") && state.selectedId,
    run:  () => editSelected() },

  // --- List navigation (single key, list focus only) ---
  { id: "nav-up",   group: "Navigation", label: "Move selection up",   keys: ["↑", "K"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && (e.key === "ArrowUp" || e.key === "k" || e.key === "K"),
    run:  () => moveSelection(-1) },
  { id: "nav-down", group: "Navigation", label: "Move selection down", keys: ["↓", "J"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && (e.key === "ArrowDown" || e.key === "j" || e.key === "J"),
    run:  () => moveSelection(1) },

  // --- Single-key list shortcuts ---
  { id: "new",      group: "Capture",    label: "New entry",            keys: ["N"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && (e.key === "n" || e.key === "N") && !state.notesViewOpen,
    run:  () => el.captureInput.focus() },
  { id: "find",     group: "Capture",    label: "Focus search",         keys: ["/"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && e.key === "/" && !state.notesViewOpen,
    run:  () => el.searchInput.focus() },
  { id: "scratch",  group: "Capture",    label: "Toggle Scratch Pad",   keys: ["S"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && (e.key === "s" || e.key === "S") && !state.notesViewOpen,
    run:  () => toggleScratchPad() },

  // --- Marker shortcuts (require selected row) ---
  // One consolidated entry rather than four hardcoded marker names — the
  // numbers map to slots 1-4 in the sidebar filter order, but the label
  // text the user sees ("Keep", "Reject", ...) can be renamed in the label
  // editor. Tying the cheatsheet to specific names would lie about what
  // the keys do as soon as anyone renames a marker.
  { id: "mark",       group: "Markers", label: "Set marker (matches sidebar order)", keys: ["1–4"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && /^[1-4]$/.test(e.key) && state.selectedId,
    run:  (e) => {
      const slot = parseInt(e.key, 10) - 1;
      const markerId = MARKERS[slot]?.id;
      if (markerId) setSelectedMarker(markerId);
    } },
  { id: "mark-clear", group: "Markers", label: "Clear marker", keys: ["0"],
    when: (e, ctx) => ctx === "list" && bareKey(e) && e.key === "0" && state.selectedId,
    run:  () => setSelectedMarker(null) },
];

function handleGlobalKey(e) {
  const ctx = focusContext();
  for (const s of SHORTCUTS) {
    if (s.when(e, ctx)) {
      if (!e.defaultPrevented) e.preventDefault();
      s.run(e);
      return;
    }
  }
}

// ---- Cheatsheet overlay (generated from SHORTCUTS) ----

function renderCheatsheetKey(label) {
  // Replace the literal "Mod" token with the platform glyph for display.
  return label.replace(/\bMod\b/g, MOD_LABEL);
}

function buildCheatsheet() {
  if (el.cheatsheetOverlay) return;
  const overlay = document.createElement("div");
  overlay.id = "cheatsheetOverlay";
  overlay.className = "cheatsheet-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Keyboard shortcuts");

  const groups = new Map();
  for (const s of SHORTCUTS) {
    if (!s.group || !s.label) continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }

  const sections = Array.from(groups.entries()).map(([group, items]) => {
    const rows = items.map((s) => {
      const keys = s.keys.map((k) => `<kbd>${escapeHtml(renderCheatsheetKey(k))}</kbd>`).join(" <span class=\"cheatsheet-or\">or</span> ");
      return `<tr><td class="cheatsheet-keys">${keys}</td><td>${escapeHtml(s.label)}</td></tr>`;
    }).join("");
    return `<section><h3>${escapeHtml(group)}</h3><table>${rows}</table></section>`;
  }).join("");

  overlay.innerHTML = `
    <div class="cheatsheet-panel">
      <header>
        <h2>Keyboard shortcuts</h2>
        <button type="button" class="cheatsheet-close" aria-label="Close">×</button>
      </header>
      <div class="cheatsheet-body">${sections}</div>
      <footer>Press <kbd>${escapeHtml(MOD_LABEL)}</kbd><kbd>/</kbd> or <kbd>?</kbd> to toggle. <kbd>Esc</kbd> to close.</footer>
    </div>
  `;
  document.body.appendChild(overlay);
  el.cheatsheetOverlay = overlay;
  overlay.querySelector(".cheatsheet-close").addEventListener("click", closeCheatsheet);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeCheatsheet();
  });
}

function toggleCheatsheet() {
  buildCheatsheet();
  if (el.cheatsheetOverlay.classList.contains("hidden")) {
    el.cheatsheetOverlay.classList.remove("hidden");
  } else {
    closeCheatsheet();
  }
}

function closeCheatsheet() {
  if (el.cheatsheetOverlay) el.cheatsheetOverlay.classList.add("hidden");
}

function handleDocClick(e) {
  if (!state.markerMenuId) return;
  if (e.target.closest(".entry-marker-menu") || e.target.closest(".entry-row-marker-btn")) return;
  closeMarkerMenu();
}

function toggleScratchPad() {
  const wasHidden = el.scratchPadPanel.classList.contains("hidden");
  if (wasHidden) {
    el.scratchPadPanel.classList.remove("hidden");
    el.scratchPadBtn.classList.add("active");
    el.scratchPadText.focus();
  } else {
    closeScratchPad();
  }
}

function closeScratchPad() {
  el.scratchPadPanel.classList.add("hidden");
  el.scratchPadBtn.classList.remove("active");
}

function openSettings() {
  renderSettings();
  positionAnchoredPopover(el.settingsPopover, el.settingsBtn);
  el.settingsPopover.classList.remove("hidden");
}

function closeSettings() {
  el.settingsPopover.classList.add("hidden");
}

function renderSettings() {
  el.themeSelect.value = normalizeThemePreference(state.session?.preferences?.theme);
  el.showTimestampsInput.checked = shouldShowTimestamps();
  el.alwaysOnTopInput.checked = Boolean(state.session?.preferences?.alwaysOnTop);
}

function normalizeThemePreference(value) {
  return ["system", "light", "dark"].includes(value) ? value : "system";
}

function applyThemePreference() {
  const theme = normalizeThemePreference(state.session?.preferences?.theme);
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

// ---- Data model ----

function makeEntry(title = "", body = "", markerId = null, source = "", order = 0) {
  return {
    id: crypto.randomUUID(),
    title,
    body,
    markerId,
    source,
    order,
    createdAt: new Date().toISOString(),
  };
}

function createDefaultSession() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "Decision Notepad",
    goal: "",
    created: now,
    updated: now,
    entries: [
      makeEntry("Candidate A", "Strong fit. Keep as the baseline comparison.", "keep", "Reference note", 0),
      makeEntry("Open question", "Need to verify whether the deadline changes the recommendation.", "question", "", 1),
      makeEntry("Old approach", "Costs more time than it saves.", "reject", "", 2),
      makeEntry("Follow-up check", "Confirm the reference is current before finalizing.", "verify", "", 3),
    ],
    scratchPad: "",
    preferences: { selectedId: "", showTimestamps: false, alwaysOnTop: false, sidebarHidden: false, theme: "system" },
    markerCustom: {},
  };
}

function defaultMarkerCustom() {
  const out = {};
  MARKERS.forEach((m) => { out[m.id] = { label: m.label, colorId: DEFAULT_MARKER_COLOR[m.id] }; });
  return out;
}

function getMarkerCustom(id) {
  const stored = state.session?.markerCustom?.[id];
  const fallback = { label: MARKER_BY_ID[id]?.label || "", colorId: DEFAULT_MARKER_COLOR[id] };
  return { ...fallback, ...(stored || {}) };
}

function markerLabel(id) { return getMarkerCustom(id).label || MARKER_BY_ID[id]?.label || ""; }

function shouldShowTimestamps() {
  return Boolean(state.session?.preferences?.showTimestamps);
}

function applyMarkerColors() {
  MARKERS.forEach((m) => {
    const { colorId } = getMarkerCustom(m.id);
    const swatch = PALETTE_BY_ID[colorId] || PALETTE_BY_ID[DEFAULT_MARKER_COLOR[m.id]];
    document.documentElement.style.setProperty(`--color-marker-${m.id}`, swatch.solid);
    document.documentElement.style.setProperty(`--color-marker-${m.id}-tint`, swatch.tint);
  });
}

function loadSession() {
  // Read through the storage adapter so this code doesn't care whether the
  // underlying persistence is localStorage, a JSON file on disk, or
  // (eventually) something else. Migration logic stays right here because
  // it's about the data shape, not about how the bytes arrived.
  try {
    const raw = storage.read(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) : null;
    if (stored && Array.isArray(stored.entries)) return normalizeSession(stored);
  } catch (err) {
    console.warn("Could not load session", err);
  }

  // Try migrating old v1 data.
  try {
    const rawOld = storage.read(LEGACY_STORAGE_KEY);
    const old = rawOld ? JSON.parse(rawOld) : null;
    if (old && Array.isArray(old.entries)) {
      const migrated = migrateV1Session(old);
      saveSessionData(migrated);
      return migrated;
    }
  } catch {}

  return createDefaultSession();
}

function migrateV1Session(old) {
  const VALID_MARKERS = new Set(["keep", "reject", "question", "verify"]);
  const V1_MAP = { evidence: null, concern: "question", draft: null, final: null };
  const now = new Date().toISOString();
  return {
    id: old.id || crypto.randomUUID(),
    title: old.title || "Decision Notepad",
    goal: typeof old.goal === "string" ? old.goal : "",
    created: old.created || now,
    updated: now,
    entries: (old.entries || []).map((e, i) => {
      let markerId = e.markerId;
      if (markerId && !VALID_MARKERS.has(markerId)) {
        markerId = V1_MAP[markerId] ?? null;
      }
      return {
        id: e.id || crypto.randomUUID(),
        title: e.title || "",
        body: e.body || "",
        markerId: markerId || null,
        source: e.source || "",
        order: Number.isFinite(e.order) ? e.order : i,
        createdAt: e.createdAt || e.created || now,
      };
    }),
    scratchPad: old.scratchPad || "",
    preferences: normalizePreferences(old.preferences),
    markerCustom: defaultMarkerCustom(),
  };
}

function normalizeSession(raw) {
  const VALID_MARKERS = new Set(["keep", "reject", "question", "verify"]);
  const now = new Date().toISOString();
  return {
    id: raw.id || crypto.randomUUID(),
    title: raw.title || "Decision Notepad",
    goal: typeof raw.goal === "string" ? raw.goal : "",
    created: raw.created || now,
    updated: raw.updated || now,
    entries: (raw.entries || []).map((e, i) => ({
      id: e.id || crypto.randomUUID(),
      title: e.title || "",
      body: e.body || "",
      markerId: VALID_MARKERS.has(e.markerId) ? e.markerId : null,
      source: e.source || "",
      order: Number.isFinite(e.order) ? e.order : i,
      createdAt: e.createdAt || now,
    })),
    scratchPad: raw.scratchPad || "",
    preferences: normalizePreferences(raw.preferences),
    markerCustom: normalizeMarkerCustom(raw.markerCustom),
  };
}

function normalizeMarkerCustom(raw) {
  const out = defaultMarkerCustom();
  if (raw && typeof raw === "object") {
    MARKERS.forEach((m) => {
      const v = raw[m.id];
      if (!v) return;
      if (typeof v.label === "string" && v.label.trim()) out[m.id].label = v.label;
      if (typeof v.colorId === "string") {
        const colorId = LEGACY_COLOR_ID_MAP[v.colorId] || v.colorId;
        if (PALETTE_BY_ID[colorId]) out[m.id].colorId = colorId;
      }
    });
  }
  return out;
}

function normalizePreferences(raw) {
  return {
    selectedId: raw?.selectedId || "",
    showTimestamps: Boolean(raw?.showTimestamps),
    alwaysOnTop: Boolean(raw?.alwaysOnTop),
    sidebarHidden: Boolean(raw?.sidebarHidden),
    theme: normalizeThemePreference(raw?.theme),
  };
}

function saveSession() {
  state.session.updated = new Date().toISOString();
  saveSessionData(state.session);
}

function saveSessionData(session) {
  storage.write(STORAGE_KEY, JSON.stringify(session));
}

// ---- Entry helpers ----

function orderedEntries() {
  return [...state.session.entries].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function filteredEntries() {
  return orderedEntries().filter((item) => {
    return filterMatches(item) && matchesSearchQuery(item, state.search);
  });
}

// Search semantics:
//   1. Whitespace splits the query into tokens; ALL tokens must match the
//      entry independently. Type `keep deadline` and you find entries
//      that mention both words, in any order, anywhere.
//   2. Each token, on its own:
//        - Long tokens (3+ chars): plain substring match, anywhere.
//        - Short tokens (1-2 chars): require a word boundary — the token
//          must start at position 0 OR be preceded by a non-alphanumeric
//          character. ("St" finds "St. Louis" / "Stewart" but not "first".)
// Rationale: appraisers searching for an entry by partial recollection
// usually remember TWO things (a name + a topic, a candidate + a marker
// word, etc.) — AND-of-tokens is what they expect. The word-boundary
// behavior for short tokens stays from the earlier fix and applies per
// token now, so a query like `St louis` still does the right thing.
function matchesSearchQuery(item, query) {
  if (!query) return true;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = (item.title + " " + item.body + " " + item.source).toLowerCase();
  return tokens.every((token) => tokenMatchesHaystack(haystack, token));
}

function tokenMatchesHaystack(haystack, token) {
  if (token.length > 2) return haystack.includes(token);
  // Word-boundary walk for short tokens: cheaper than a regex per call,
  // and avoids regex-escaping the raw user input.
  let idx = 0;
  while ((idx = haystack.indexOf(token, idx)) !== -1) {
    if (idx === 0) return true;
    const prev = haystack.charCodeAt(idx - 1);
    const isAlnum =
      (prev >= 48 && prev <= 57) ||   // 0-9
      (prev >= 97 && prev <= 122);    // a-z (haystack is lowercased)
    if (!isAlnum) return true;
    idx += 1;
  }
  return false;
}

function filterMatches(item) {
  if (state.filter === "All") return true;
  if (state.filter === "unlabeled") return !item.markerId;
  if (state.filter === "has-source") return Boolean(item.source?.trim());
  if (state.filter === "no-source") return !item.source?.trim();
  return item.markerId === state.filter;
}

function selectedEntry() {
  return state.session.entries.find((e) => e.id === state.selectedId) || null;
}

function nextOrder() {
  return state.session.entries.reduce((max, e) => Math.max(max, e.order || 0), -1) + 1;
}

// ---- Mutations ----

function createEntry(title) {
  withUndo(() => {
    const item = makeEntry(title, "", null, "", nextOrder());
    state.session.entries.push(item);
    state.selectedId = item.id;
    state.session.preferences.selectedId = item.id;
    saveSession();
    renderFilters();
    renderEntries();
    renderFooter();
    // Focus inline body on the new row
    requestAnimationFrame(() => {
      const row = el.entryList.querySelector(`[data-id="${item.id}"]`);
      if (row) startInlineBodyEdit(row, item);
    });
  });
}

function updateSelected(patch) {
  const item = selectedEntry();
  if (!item) return;
  Object.assign(item, patch);
  saveSession();
}

function setSelectedMarker(markerId) {
  withUndo(() => {
    state.markerMenuId = null;
    updateSelected({ markerId: markerId || null });
    const row = el.entryList.querySelector(`[data-id="${state.selectedId}"]`);
    const item = selectedEntry();
    if (row && item) {
      row.dataset.marker = item.markerId || "";
      refreshRowContent(row, item);
    }
    if (state.detailOpen) renderDetailMarker();
    if (state.notesViewOpen) renderNotesView();
    renderFilters();
    renderEntries();
    renderFooter();
  });
}

function toggleMarkerMenu(id) {
  if (state.editingRowId) commitInlineEdit(state.editingRowId);
  state.selectedId = id;
  state.session.preferences.selectedId = id;
  state.markerMenuId = state.markerMenuId === id ? null : id;
  saveSession();
  renderEntries();
  if (state.detailOpen) renderDetail();
}

function closeMarkerMenu() {
  state.markerMenuId = null;
  renderEntries();
  restoreFocusToSelectedRow();
}

function setEntryMarkerFromMenu(id, markerId) {
  withUndo(() => {
    if (state.editingRowId) commitInlineEdit(state.editingRowId);
    state.selectedId = id;
    state.session.preferences.selectedId = id;
    state.markerMenuId = null;
    updateSelected({ markerId: markerId || null });
    renderFilters();
    renderEntries();
    renderFooter();
    if (state.detailOpen) renderDetail();
    if (state.notesViewOpen) renderNotesView();
  });
  // Restore focus to the selected row so subsequent keyboard shortcuts
  // (notably Mod+Z) reach our document handler instead of escaping the
  // page to the browser's URL bar.
  restoreFocusToSelectedRow();
}

function deleteSelected() {
  if (!state.selectedId) return;
  withUndo(() => {
    const idx = orderedEntries().findIndex((e) => e.id === state.selectedId);
    state.session.entries = state.session.entries.filter((e) => e.id !== state.selectedId);
    const next = orderedEntries()[Math.max(0, idx - 1)] || null;
    state.selectedId = next?.id || null;
    state.session.preferences.selectedId = state.selectedId || "";
    state.detailOpen = false;
    state.notesViewOpen = false;
    el.notesView.classList.add("hidden");
    saveSession();
    renderAll();
  });
}

// ---- Render ----

function renderAll() {
  el.sessionTitle.value = state.session.title;
  el.goalText.value = state.session.goal || "";
  renderGoalPreview();
  el.scratchPadText.value = state.session.scratchPad || "";
  renderFilters();
  renderEntries();
  renderDetail();
  renderFooter();
}

function renderGoalPreview() {
  const goal = state.session.goal?.trim();
  el.goalPreview.textContent = goal || "Add goal";
  el.goalPreview.classList.toggle("empty", !goal);
}

function renderFilters() {
  const counts = {};
  state.session.entries.forEach((e) => {
    if (e.markerId) counts[e.markerId] = (counts[e.markerId] || 0) + 1;
  });
  const total = filteredEntries().length;
  const unlabeled = state.session.entries.filter((e) => !e.markerId).length;
  const hasSource = state.session.entries.filter((e) => e.source?.trim()).length;
  const noSource = state.session.entries.length - hasSource;

  // Impressions
  el.impressionFilters.innerHTML = "";
  const impressions = [
    { id: "All", label: "All", count: state.session.entries.length },
    ...MARKERS.map((m) => ({ id: m.id, label: markerLabel(m.id), count: counts[m.id] || 0 })),
    { id: "unlabeled", label: "Unlabeled", count: unlabeled },
  ];
  impressions.forEach(({ id, label, count }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-row" + (state.filter === id ? " active" : "");
    btn.innerHTML = `<span class="filter-row-label">${escapeHtml(label)}</span><span class="filter-row-count">${count}</span>`;
    btn.addEventListener("click", () => {
      state.filter = id;
      renderFilters();
      renderEntries();
      renderFooter();
    });
    el.impressionFilters.appendChild(btn);
  });

  // Properties (hide zero-count)
  el.propertyFilters.innerHTML = "";
  const properties = [
    { id: "has-source", label: "Has reference", count: hasSource },
    { id: "no-source", label: "No reference", count: noSource },
  ];
  properties.forEach(({ id, label, count }) => {
    if (count === 0) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-row" + (state.filter === id ? " active" : "");
    btn.innerHTML = `<span class="filter-row-label">${escapeHtml(label)}</span><span class="filter-row-count">${count}</span>`;
    btn.addEventListener("click", () => {
      state.filter = id;
      renderFilters();
      renderEntries();
      renderFooter();
    });
    el.propertyFilters.appendChild(btn);
  });
}

function renderEntries() {
  const visible = filteredEntries();
  el.entryList.innerHTML = "";

  if (!state.session.entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Press N to add your first entry.";
    el.entryList.appendChild(empty);
    return;
  }

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No entries match this filter.";
    el.entryList.appendChild(empty);
    return;
  }

  visible.forEach((item) => {
    el.entryList.appendChild(buildRow(item));
  });
}

function buildRow(item) {
  const row = document.createElement("article");
  row.className = "entry-row" + (item.id === state.selectedId ? " selected" : "");
  row.dataset.id = item.id;
  row.dataset.marker = item.markerId || "";
  row.setAttribute("role", "listitem");
  row.tabIndex = 0;

  const glyph = item.markerId ? MARKER_BY_ID[item.markerId]?.glyph || "" : "";
  const markerMenuOpen = state.markerMenuId === item.id;

  row.innerHTML = `
    <div class="entry-row-edge"></div>
    <div class="entry-row-marker-wrap">
      <button class="entry-row-marker-btn" type="button" aria-label="Set marker for ${escapeHtml(item.title || "Untitled entry")}" aria-expanded="${markerMenuOpen ? "true" : "false"}">
        ${escapeHtml(glyph || "+")}
      </button>
      ${markerMenuOpen ? markerMenuHtml(item) : ""}
    </div>
    <div class="entry-row-content">
      ${rowContentHtml(item)}
    </div>
    <div class="entry-row-drag" aria-hidden="true">=</div>
  `;

  row.addEventListener("click", (e) => {
    if (state.editingRowId === item.id) return;
    selectRow(item.id);
  });

  row.addEventListener("dblclick", (e) => {
    const content = row.querySelector(".entry-row-content");
    if (content && content.contains(e.target)) {
      e.preventDefault();
      startInlineEdit(row, item);
    }
  });

  row.addEventListener("keydown", (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter") {
      e.preventDefault();
      selectRow(item.id);
    }
  });

  wireDragHandle(row, item);

  const markerBtn = row.querySelector(".entry-row-marker-btn");
  markerBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMarkerMenu(item.id);
  });

  row.querySelectorAll(".entry-marker-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setEntryMarkerFromMenu(item.id, btn.dataset.marker || null);
    });
  });

  return row;
}

function markerMenuHtml(item) {
  const options = MARKERS.map((m) => {
    const active = item.markerId === m.id ? " active" : "";
    return `
      <button class="entry-marker-menu-btn${active}" type="button" data-marker="${m.id}">
        <span class="entry-marker-menu-glyph">${escapeHtml(m.glyph)}</span>
        ${escapeHtml(markerLabel(m.id))}
      </button>
    `;
  }).join("");
  return `
    <div class="entry-marker-menu" role="menu" aria-label="Set marker">
      ${options}
      <button class="entry-marker-menu-btn" type="button" data-marker="">
        <span class="entry-marker-menu-glyph">0</span>
        Unlabeled
      </button>
    </div>
  `;
}

function rowContentHtml(item) {
  const hasSource = Boolean(item.source?.trim());
  const titleDisplay = item.title || "Untitled entry";
  const titleClass = item.title ? "entry-row-title" : "entry-row-title placeholder";

  // Build the meta left side as structured HTML so the marker name can be
  // visually distinguished from the freeform reference text. They were
  // previously joined as one plain string ("Question · MLS#41822") and
  // blurred together. Now: marker name is semibold (categorical label),
  // reference stays regular weight (freeform content). Same color, just
  // luminance contrast — readable regardless of color vision.
  const markerName = item.markerId ? markerLabel(item.markerId) : "";
  const referenceText = item.source?.trim() || "";
  const metaLeftParts = [];
  if (markerName) {
    metaLeftParts.push(`<span class="entry-row-meta-marker">${escapeHtml(markerName)}</span>`);
  }
  if (referenceText) {
    metaLeftParts.push(`<span class="entry-row-meta-reference">${escapeHtml(referenceText)}</span>`);
  }
  const metaLeftHtml = metaLeftParts.join(`<span class="entry-row-meta-sep"> · </span>`);
  const hasMeta = metaLeftHtml.length > 0;
  const timestamp = shouldShowTimestamps() && item.createdAt ? formatTimestamp(item.createdAt) : "";

  return `
    <div class="entry-row-title-line">
      <span class="${escapeHtml(titleClass)}">${escapeHtml(titleDisplay)}</span>
      ${hasSource ? `<span class="entry-row-source-check" title="Has reference" aria-label="Has reference">✓</span>` : ""}
    </div>
    ${item.body ? `<div class="entry-row-body">${escapeHtml(item.body)}</div>` : ""}
    ${hasMeta || timestamp ? `
    <div class="entry-row-meta">
      <span class="entry-row-meta-left">${metaLeftHtml}</span>
      <span class="entry-row-meta-time">${escapeHtml(timestamp)}</span>
    </div>` : ""}
  `;
}

function refreshRowContent(row, item) {
  const content = row.querySelector(".entry-row-content");
  if (!content) return;
  content.innerHTML = rowContentHtml(item);
  row.dataset.marker = item.markerId || "";
  const markerBtn = row.querySelector(".entry-row-marker-btn");
  if (markerBtn) markerBtn.textContent = item.markerId ? MARKER_BY_ID[item.markerId]?.glyph || "" : "+";
}

function selectRow(id) {
  if (state.editingRowId) commitInlineEdit(state.editingRowId);
  state.selectedId = id;
  state.session.preferences.selectedId = id;
  saveSession();

  // Update visual class AND move DOM focus to the matching row. Focus on
  // the row is what keeps J/K and other list-context shortcuts firing for
  // subsequent keystrokes — without it, focus can drift to body or an
  // input and the user's next keypress wouldn't reach the list shortcuts.
  // preventScroll avoids stealing scroll position; callers that want to
  // scroll the row into view do that explicitly (see moveSelection).
  let matchedRow = null;
  el.entryList.querySelectorAll(".entry-row").forEach((r) => {
    const isMatch = r.dataset.id === id;
    r.classList.toggle("selected", isMatch);
    if (isMatch) matchedRow = r;
  });
  if (matchedRow && typeof matchedRow.focus === "function") {
    matchedRow.focus({ preventScroll: true });
  }

  if (state.detailOpen) renderDetail();
}

// After a destructive re-render (popup marker click, delete, etc.) the
// element the user was interacting with no longer exists. Without this,
// focus escapes the page in some browsers (Chrome lands on the URL bar),
// which means our document keyboard listener never receives subsequent
// keys like Mod+Z. Pinning focus to the selected row keeps the keyboard
// model intact.
function restoreFocusToSelectedRow() {
  // Wait one frame for the re-render to land, then focus the new row.
  requestAnimationFrame(() => {
    const id = state.selectedId;
    if (!id) { document.body.focus?.(); return; }
    const row = el.entryList.querySelector(`[data-id="${id}"]`);
    if (row && typeof row.focus === "function") row.focus({ preventScroll: true });
  });
}

// ---- Drag-to-reorder ----------------------------------------------------
//
// Native HTML5 drag/drop, no library. Drag is initiated only when the
// mousedown lands on `.entry-row-drag` (the 3-line handle on row hover) —
// this keeps clicks and text selection on the rest of the row from
// triggering a drag. The `order` field on each entry is reassigned 0..N
// after a drop, which avoids fractional-order complexity.

const dragState = { id: null, overId: null, position: null };

function wireDragHandle(row, item) {
  // Drag model: the WHOLE ROW is the draggable element, but a drag only
  // *actually starts* if the mousedown originated on the .entry-row-drag
  // handle. We track that via a closure variable set in mousedown and
  // checked in dragstart. If the user mousedowned anywhere else, the
  // dragstart cancels itself.
  //
  // History: previously made the handle itself draggable. That worked in
  // Chrome but not in WKWebView — `dragover` events on the row weren't
  // routing properly when the drag source was a child element, so the
  // OS treated every drop as a "copy" (green-plus cursor) instead of a
  // move. The whole-row-with-gate pattern is more robust across engines.
  let mousedownOnHandle = false;
  row.draggable = true;

  row.addEventListener("mousedown", (e) => {
    mousedownOnHandle = Boolean(e.target.closest(".entry-row-drag"));
  });

  row.addEventListener("dragstart", (e) => {
    if (!mousedownOnHandle || state.editingRowId) {
      e.preventDefault();
      return;
    }
    dragState.id = item.id;

    // Drag ghost image. WKWebView doesn't render a default ghost reliably
    // for div rows, and even where it does, our `.dragging` opacity rule
    // would make the snapshot nearly invisible. Solution: clone the row,
    // position it offscreen at full opacity, use the clone as the drag
    // image. The clone is removed on the next tick — the browser needs
    // it in the DOM long enough to snapshot, but no longer.
    const rect = row.getBoundingClientRect();
    const clone = row.cloneNode(true);
    clone.style.position = "absolute";
    clone.style.top = "-9999px";
    clone.style.left = "-9999px";
    clone.style.width = `${rect.width}px`;
    clone.style.opacity = "1";
    clone.classList.remove("dragging", "selected", "drag-over-above", "drag-over-below");
    document.body.appendChild(clone);
    try {
      e.dataTransfer.setDragImage(clone, e.clientX - rect.left, e.clientY - rect.top);
    } catch {}
    setTimeout(() => clone.remove(), 0);

    row.classList.add("dragging");
    // Some engines refuse to start the drag without dataTransfer payload.
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", item.id); } catch {}
  });

  row.addEventListener("dragend", () => {
    mousedownOnHandle = false;
    row.classList.remove("dragging");
    clearDropIndicators();
    dragState.id = null;
    dragState.overId = null;
    dragState.position = null;
  });

  row.addEventListener("dragover", (e) => {
    if (!dragState.id || dragState.id === item.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const above = (e.clientY - rect.top) < rect.height / 2;
    const position = above ? "above" : "below";
    if (dragState.overId !== item.id || dragState.position !== position) {
      clearDropIndicators();
      dragState.overId = item.id;
      dragState.position = position;
      row.classList.add(above ? "drag-over-above" : "drag-over-below");
    }
  });

  row.addEventListener("dragleave", (e) => {
    // Only clear if leaving for an element outside this row — child elements
    // fire dragleave too and would cause flicker.
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove("drag-over-above", "drag-over-below");
    }
  });

  row.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragState.id || dragState.id === item.id) return;
    reorderEntry(dragState.id, item.id, dragState.position || "below");
  });
}

function clearDropIndicators() {
  el.entryList.querySelectorAll(".drag-over-above, .drag-over-below")
    .forEach((r) => r.classList.remove("drag-over-above", "drag-over-below"));
}

// Drop-zone handlers on the LIST CONTAINER, not the individual rows.
// Without these, dragging into the empty space below the last row produces
// no `dragover` events on any row (nothing's under the cursor down there),
// so the indicator never appears and the drop never registers. By catching
// dragover/drop on the list and treating "cursor below all rows" as
// "drop below the last row," reordering to the end of the list works
// naturally regardless of how much empty space is left in the list area.
function handleListDragOver(e) {
  if (!dragState.id) return;
  // If a row is the actual target, let the row's own handler take it.
  if (e.target && e.target.closest && e.target.closest(".entry-row")) return;
  const rows = Array.from(el.entryList.querySelectorAll(".entry-row"));
  if (!rows.length) return;
  const lastRow = rows[rows.length - 1];
  if (lastRow.dataset.id === dragState.id) return; // can't drop onto self
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  if (dragState.overId !== lastRow.dataset.id || dragState.position !== "below") {
    clearDropIndicators();
    dragState.overId = lastRow.dataset.id;
    dragState.position = "below";
    lastRow.classList.add("drag-over-below");
  }
}

function handleListDrop(e) {
  if (!dragState.id) return;
  if (e.target && e.target.closest && e.target.closest(".entry-row")) return;
  if (!dragState.overId || !dragState.position) return;
  e.preventDefault();
  if (dragState.id === dragState.overId) return;
  reorderEntry(dragState.id, dragState.overId, dragState.position);
}

function reorderEntry(fromId, toId, position) {
  withUndo(() => {
    // Reorder operates on the canonical entry list, not the filtered view.
    // The filter is a render-time projection; the saved order should reflect
    // the user's overall intent, not the current filter window.
    const list = state.session.entries.slice().sort((a, b) => a.order - b.order);
    const fromIdx = list.findIndex((e) => e.id === fromId);
    const toIdx = list.findIndex((e) => e.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    const [moved] = list.splice(fromIdx, 1);
    // After splicing out `moved`, indices >= fromIdx shifted left by 1.
    let insertIdx = toIdx;
    if (fromIdx < toIdx) insertIdx -= 1;
    if (position === "below") insertIdx += 1;
    insertIdx = Math.max(0, Math.min(list.length, insertIdx));
    list.splice(insertIdx, 0, moved);

    // Rewrite all order values 0..N so the new positions stick.
    list.forEach((e, i) => { e.order = i; });
    saveSession();
    renderEntries();
  });
}

// ---- Inline editing ----

function startInlineEdit(row, item) {
  if (state.editingRowId === item.id) return;
  if (state.editingRowId) commitInlineEdit(state.editingRowId);
  state.editingRowId = item.id;

  const content = row.querySelector(".entry-row-content");
  content.innerHTML = `
    <div class="entry-row-inline">
      <input class="inline-title-input" type="text" value="${escapeHtml(item.title)}" placeholder="Title" aria-label="Entry title">
      <textarea class="inline-body-input" rows="4" placeholder="Note" aria-label="Entry note">${escapeHtml(item.body || "")}</textarea>
      <label class="inline-source-field">
        <span>Ref</span>
        <input class="inline-source-input" type="text" value="${escapeHtml(item.source || "")}" placeholder="Reference" aria-label="Entry reference">
      </label>
      <span class="inline-hint">Esc to finish editing</span>
    </div>
  `;

  const titleInput = content.querySelector(".inline-title-input");
  const bodyInput = content.querySelector(".inline-body-input");
  const sourceInput = content.querySelector(".inline-source-input");

  titleInput.focus();
  titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);

  titleInput.addEventListener("input", () => updateSelected({ title: titleInput.value }));
  bodyInput.addEventListener("input", () => updateSelected({ body: bodyInput.value }));
  sourceInput.addEventListener("input", () => {
    updateSelected({ source: sourceInput.value });
    if (state.detailOpen) {
      el.detailSourceInput.value = sourceInput.value;
      updateDetailStatus();
    }
    refreshReferenceDependentSurfaces({ renderList: false });
  });

  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); bodyInput.focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commitInlineEdit(item.id); }
    if (e.key === "Escape") { e.preventDefault(); commitInlineEdit(item.id); }
  });

  bodyInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commitInlineEdit(item.id); }
    if (e.key === "Escape") { e.preventDefault(); commitInlineEdit(item.id); }
  });

  sourceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) { e.preventDefault(); commitInlineEdit(item.id); }
    if (e.key === "Escape") { e.preventDefault(); commitInlineEdit(item.id); }
  });

  titleInput.addEventListener("blur", () => {
    requestAnimationFrame(() => {
      if (state.editingRowId === item.id && document.activeElement !== bodyInput && document.activeElement !== sourceInput) {
        commitInlineEdit(item.id);
      }
    });
  });

  bodyInput.addEventListener("blur", () => {
    requestAnimationFrame(() => {
      if (state.editingRowId === item.id && document.activeElement !== titleInput && document.activeElement !== sourceInput) {
        commitInlineEdit(item.id);
      }
    });
  });

  sourceInput.addEventListener("blur", () => {
    requestAnimationFrame(() => {
      if (state.editingRowId === item.id && document.activeElement !== titleInput && document.activeElement !== bodyInput) {
        commitInlineEdit(item.id);
      }
    });
  });
}

function startInlineBodyEdit(row, item) {
  state.editingRowId = item.id;
  state.selectedId = item.id;

  const content = row.querySelector(".entry-row-content");
  content.innerHTML = `
    <div class="entry-row-inline">
      <input class="inline-title-input" type="text" value="${escapeHtml(item.title)}" placeholder="Title" aria-label="Entry title">
      <textarea class="inline-body-input" rows="4" placeholder="Note" aria-label="Entry note">${escapeHtml(item.body || "")}</textarea>
      <label class="inline-source-field">
        <span>Ref</span>
        <input class="inline-source-input" type="text" value="${escapeHtml(item.source || "")}" placeholder="Reference" aria-label="Entry reference">
      </label>
      <span class="inline-hint">Esc to finish editing</span>
    </div>
  `;
  row.classList.add("selected");

  const titleInput = content.querySelector(".inline-title-input");
  const bodyInput = content.querySelector(".inline-body-input");
  const sourceInput = content.querySelector(".inline-source-input");

  bodyInput.focus();

  titleInput.addEventListener("input", () => updateSelected({ title: titleInput.value }));
  bodyInput.addEventListener("input", () => updateSelected({ body: bodyInput.value }));
  sourceInput.addEventListener("input", () => {
    updateSelected({ source: sourceInput.value });
    if (state.detailOpen) {
      el.detailSourceInput.value = sourceInput.value;
      updateDetailStatus();
    }
    refreshReferenceDependentSurfaces({ renderList: false });
  });

  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); bodyInput.focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commitInlineEdit(item.id); }
    if (e.key === "Escape") { e.preventDefault(); commitInlineEdit(item.id); }
  });

  bodyInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commitInlineEdit(item.id); }
    if (e.key === "Escape") { e.preventDefault(); commitInlineEdit(item.id); }
  });

  sourceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) { e.preventDefault(); commitInlineEdit(item.id); }
    if (e.key === "Escape") { e.preventDefault(); commitInlineEdit(item.id); }
  });

  titleInput.addEventListener("blur", () => {
    requestAnimationFrame(() => {
      if (state.editingRowId === item.id && document.activeElement !== bodyInput && document.activeElement !== sourceInput) {
        commitInlineEdit(item.id);
      }
    });
  });

  bodyInput.addEventListener("blur", () => {
    requestAnimationFrame(() => {
      if (state.editingRowId === item.id && document.activeElement !== titleInput && document.activeElement !== sourceInput) {
        commitInlineEdit(item.id);
      }
    });
  });

  sourceInput.addEventListener("blur", () => {
    requestAnimationFrame(() => {
      if (state.editingRowId === item.id && document.activeElement !== titleInput && document.activeElement !== bodyInput) {
        commitInlineEdit(item.id);
      }
    });
  });
}

function commitInlineEdit(id) {
  if (state.editingRowId !== id) return;
  state.editingRowId = null;
  const item = state.session.entries.find((e) => e.id === id);
  const row = el.entryList.querySelector(`[data-id="${id}"]`);
  if (item && row) {
    if (state.search || state.filter === "has-source" || state.filter === "no-source") {
      renderEntries();
    } else {
      const content = row.querySelector(".entry-row-content");
      if (content) content.innerHTML = rowContentHtml(item);
    }
  }
  renderFilters();
  renderFooter();
  if (state.detailOpen) renderDetail();
}

// ---- Marker label / legend / editor ----

const MARKER_DESCRIPTIONS = {
  keep: "currently believe this supports the decision.",
  reject: "currently believe this does not support it.",
  question: "open question to resolve before finalizing.",
  verify: "claim not yet checked against a reference.",
};

function renderLegend() {
  el.legendTableBody.innerHTML = MARKERS.map((m) => {
    const currentLabel = markerLabel(m.id);
    const isDefaultLabel = currentLabel.trim() === m.label;
    const description = isDefaultLabel ? MARKER_DESCRIPTIONS[m.id] : "";
    return `
      <tr>
        <td><span class="marker-glyph marker-glyph--${m.id}">${escapeHtml(m.glyph)}</span></td>
        <td><strong>${escapeHtml(currentLabel)}</strong>${description ? ` — ${description}` : ""}</td>
      </tr>
    `;
  }).join("");
}

function openLabelEditor() {
  renderLabelEditor();
  positionAnchoredPopover(el.labelEditor, el.labelEditorBtn);
  el.labelEditor.classList.remove("hidden");
}

function openGoalEditor() {
  el.goalText.value = state.session.goal || "";
  el.goalEditor.classList.remove("hidden");
  el.goalBtn.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    el.goalText.focus();
    const len = el.goalText.value.length;
    el.goalText.setSelectionRange(len, len);
  });
}

function closeGoalEditor() {
  el.goalEditor.classList.add("hidden");
  el.goalBtn.setAttribute("aria-expanded", "false");
}

function renderLabelEditor() {
  el.labelEditorRows.innerHTML = MARKERS.map((m) => {
    const custom = getMarkerCustom(m.id);
    const swatches = COLOR_PALETTE.map((c) => `
      <button type="button" class="swatch${c.id === custom.colorId ? " selected" : ""}"
        data-marker="${m.id}" data-color="${c.id}"
        style="--swatch-color: ${c.solid}; --swatch-ring: ${c.tint}" aria-label="${c.id}"></button>
    `).join("");
    return `
      <div class="label-editor-row">
        <div class="label-editor-row-top">
          <span class="label-editor-glyph" style="color: ${PALETTE_BY_ID[custom.colorId].solid}">${escapeHtml(m.glyph)}</span>
          <input type="text" class="label-editor-input" data-marker="${m.id}" value="${escapeHtml(custom.label)}" maxlength="24" aria-label="${m.id} label">
        </div>
        <div class="label-editor-swatches">${swatches}</div>
      </div>
    `;
  }).join("");

  el.labelEditorRows.querySelectorAll(".label-editor-input").forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.dataset.marker;
      state.session.markerCustom[id] = state.session.markerCustom[id] || {};
      state.session.markerCustom[id].label = input.value;
      saveSession();
      rerenderMarkersEverywhere();
    });
  });

  el.labelEditorRows.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.marker;
      const colorId = btn.dataset.color;
      state.session.markerCustom[id] = state.session.markerCustom[id] || {};
      state.session.markerCustom[id].colorId = colorId;
      saveSession();
      applyMarkerColors();
      renderLabelEditor();
      rerenderMarkersEverywhere();
    });
  });
}

function rerenderMarkersEverywhere() {
  renderFilters();
  renderEntries();
  renderFooter();
  if (state.detailOpen) {
    renderDetailMarker();
    updateDetailStatus();
  }
  if (state.notesViewOpen) renderNotesView();
}

// ---- Export ----

function openExport() {
  setExportStatus("");
  positionAnchoredPopover(el.exportPopover, el.exportBtn);
  el.exportPopover.classList.remove("hidden");
}

function closeExport() {
  el.exportPopover.classList.add("hidden");
  closeAiReview();
  setExportStatus("");
}

// Status is shown in two places:
//   - Inside the export popover (only visible when popover is open)
//   - In the footer (always visible; auto-clears after a few seconds)
// The footer copy is what menu-triggered actions rely on, since the
// popover isn't open in that flow.
let footerStatusTimer = null;
function setExportStatus(msg, kind = "") {
  el.exportStatus.textContent = msg;
  el.exportStatus.className = "export-status" + (kind ? " " + kind : "");
  if (el.footerStatus) {
    el.footerStatus.textContent = msg;
    el.footerStatus.className = "footer-status" + (kind ? " " + kind : "");
    if (footerStatusTimer) clearTimeout(footerStatusTimer);
    if (msg) {
      footerStatusTimer = setTimeout(() => {
        if (el.footerStatus.textContent === msg) {
          el.footerStatus.textContent = "";
          el.footerStatus.className = "footer-status";
        }
      }, 3500);
    }
  }
}

function exportFilenameStem() {
  const title = (state.session.title || "decision-notepad").replace(/\s+/g, "-").replace(/[^A-Za-z0-9_\-]/g, "");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${title || "notepad"}-${stamp}`;
}

// ---- Export pipeline ----------------------------------------------------
//
// One format registry, two writer adapters (download / clipboard). All
// export buttons go through `exportToDownload(formatId)` or
// `exportToClipboard(formatId)`, so on Tauri day the only swap is the body
// of `downloadAdapter` (Blob+<a> → tauri-plugin-dialog + tauri-plugin-fs).
// Adding a new format = one entry in EXPORT_FORMATS; no wiring elsewhere.

const EXPORT_FORMATS = {
  json: {
    id: "json",
    label: "Notepad backup",
    extension: "json",
    mime: "application/json",
    build: (session) => JSON.stringify(session, null, 2),
  },
  markdown: {
    id: "markdown",
    label: "Markdown",
    extension: "md",
    mime: "text/markdown",
    build: (session) => buildMarkdown(session),
  },
  // AI Review is handled separately because its body is user-edited in the
  // textarea before send-off; it doesn't fit the "build from session" shape.
};

// Writer adapter: write text to a file. Two code paths:
//   - Tauri: native Save As dialog (`plugin:dialog|save`) → user picks the
//     path → write text via `plugin:fs|write_text_file`. Permissions and
//     fs scopes are declared in src-tauri/capabilities/default.json.
//   - Browser: classic <a download> + Blob URL dance.
//
// Returns true if the file was saved, false if the user cancelled the
// dialog, throws on actual error. Callers use the return value to choose
// between "Saved." / "Cancelled." status messages.
async function downloadAdapter(text, filename, mime) {
  // Find Tauri's invoke. The path differs across versions / configs:
  //   - 2.x with withGlobalTauri: window.__TAURI__.core.invoke
  //   - 2.x internals (always present in Tauri): window.__TAURI_INTERNALS__.invoke
  //   - 1.x legacy: window.__TAURI__.invoke
  // If none of these exist, we're in a plain browser and fall through.
  const invoke =
    (typeof window !== "undefined" && (
      window.__TAURI__?.core?.invoke ||
      window.__TAURI_INTERNALS__?.invoke ||
      window.__TAURI__?.invoke
    )) || null;

  if (invoke) {
    // Map extension to a human-readable filter label for the save dialog.
    const ext = filename.includes(".") ? filename.split(".").pop() : "";
    const filterLabel = {
      md: "Markdown", json: "JSON", txt: "Text", rtf: "Rich Text",
    }[ext] || (ext ? ext.toUpperCase() : "File");

    // Tauri 2's dialog plugin expects args wrapped in an `options` key.
    // The fs plugin uses positional-ish args (path, contents) at the top level.
    const path = await invoke("plugin:dialog|save", {
      options: {
        defaultPath: filename,
        filters: ext ? [{ name: filterLabel, extensions: [ext] }] : undefined,
      },
    });
    if (!path) return false; // user cancelled
    // tauri-plugin-fs uses HTTP-style invoke semantics:
    //   - args (positional): the file body as binary bytes (Uint8Array)
    //   - options.headers: path (URL-encoded) and serialized options
    // This is different from most plugins (which take a plain args object)
    // because file bodies can be huge and shipping them as bytes is faster
    // than JSON-stringifying them. Reference: tauri-apps/plugins-workspace
    // plugins/fs/guest-js/index.ts.
    const body = new TextEncoder().encode(text);
    await invoke("plugin:fs|write_text_file", body, {
      headers: {
        path: encodeURIComponent(path),
        options: JSON.stringify({}),
      },
    });
    return true;
  }

  // Browser fallback.
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

// Writer adapter: write text to the system clipboard. Same on Tauri.
async function clipboardAdapter(text) {
  await navigator.clipboard.writeText(text);
}

async function exportToDownload(formatId) {
  const fmt = EXPORT_FORMATS[formatId];
  if (!fmt) {
    setExportStatus(`Unknown export format: ${formatId}`, "error");
    return;
  }
  try {
    const text = fmt.build(state.session);
    const saved = await downloadAdapter(text, `${exportFilenameStem()}.${fmt.extension}`, fmt.mime);
    setExportStatus(saved ? `${fmt.label} saved.` : `Save cancelled.`, saved ? "success" : "");
  } catch (err) {
    console.warn(`${fmt.label} save failed`, err);
    setExportStatus(`Could not save ${fmt.label}.`, "error");
  }
}

async function openAppDataFolder() {
  if (!tauriInvoke) {
    setExportStatus("Data folder is available in the Tauri app.", "error");
    return;
  }
  try {
    await tauriInvoke("open_app_data_folder");
    setExportStatus("Data folder opened.", "success");
  } catch (err) {
    console.warn("Could not open data folder", err);
    setExportStatus("Could not open data folder.", "error");
  }
}

async function exportToClipboard(formatId) {
  const fmt = EXPORT_FORMATS[formatId];
  if (!fmt) {
    setExportStatus(`Unknown export format: ${formatId}`, "error");
    return;
  }
  const text = fmt.build(state.session);
  try {
    await clipboardAdapter(text);
    setExportStatus(`Copied ${fmt.label} to clipboard.`, "success");
  } catch (err) {
    console.warn(`Clipboard write failed; falling back to save dialog`, err);
    try {
      const saved = await downloadAdapter(text, `${exportFilenameStem()}.${fmt.extension}`, fmt.mime);
      setExportStatus(saved ? `Clipboard blocked — saved ${fmt.label} instead.` : `Save cancelled.`, saved ? "success" : "");
    } catch (err2) {
      setExportStatus(`Could not copy or save ${fmt.label}.`, "error");
    }
  }
}

function exportJSON() {
  exportToDownload("json");
}

function restoreJSONBackup() {
  const file = el.jsonRestoreInput.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || ""));
      if (!isReasoningBackup(parsed)) {
        setExportStatus("That file does not look like a Reasoning Notepad backup.", "error");
        return;
      }
      const ok = confirm("Open this notepad backup? This will replace the current notepad in this app. Save a backup of the current notepad first if you want to keep it.");
      if (!ok) return;

      state.session = normalizeSession(parsed);
      state.selectedId = state.session.preferences.selectedId || "";
      state.detailOpen = false;
      state.notesViewOpen = false;
      state.editingRowId = null;
      state.search = "";
      state.filter = "All";
      el.searchInput.value = "";
      el.detailPanel.classList.add("hidden");
      el.notesView.classList.add("hidden");
      document.getElementById("appShell").classList.remove("notes-active");
      applyMarkerColors();
      saveSession();
      renderAll();
      setExportStatus("Notepad backup opened.", "success");
    } catch (err) {
      console.warn("JSON restore failed", err);
      setExportStatus("Could not open that notepad backup.", "error");
    } finally {
      el.jsonRestoreInput.value = "";
    }
  };
  reader.onerror = () => {
    setExportStatus("Could not read that backup file.", "error");
    el.jsonRestoreInput.value = "";
  };
  reader.readAsText(file);
}

function isReasoningBackup(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.entries));
}

function downloadMarkdown() {
  exportToDownload("markdown");
}

async function exportMarkdown() {
  await exportToClipboard("markdown");
}

function buildMarkdown(session) {
  const lines = [];
  const scratchPad = session.scratchPad?.trim();
  if (scratchPad) {
    lines.push("# Scratch Pad / Rough Material");
    lines.push("");
    lines.push(scratchPad);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  lines.push(`# ${session.title || "Decision Notepad"}`);
  lines.push("");
  const goal = session.goal?.trim();
  if (goal) {
    lines.push("## Goal");
    lines.push("");
    lines.push(goal);
    lines.push("");
  }
  const sorted = [...session.entries].sort((a, b) => (a.order || 0) - (b.order || 0));
  sorted.forEach((e) => {
    const label = e.markerId ? markerLabel(e.markerId) : "";
    const heading = e.title || "Untitled entry";
    lines.push(label ? `## ${heading} — ${label}` : `## ${heading}`);
    if (e.body) { lines.push(""); lines.push(e.body); }
    if (e.source?.trim()) { lines.push(""); lines.push(`_Reference: ${e.source.trim()}_`); }
    lines.push("");
  });
  return lines.join("\n");
}

function openAiReview() {
  el.aiReviewPanel.classList.remove("hidden");
  updateAiPresetDescription();
  renderAiReviewPreview(true);
  el.aiReviewPreview.focus();
}

function closeAiReview() {
  if (!el.aiReviewPanel) return;
  el.aiReviewPanel.classList.add("hidden");
}

function handleAiOptionsChanged() {
  updateAiPresetDescription();
  if (state.aiReviewDirty) {
    setExportStatus("AI instructions changed. Use Regenerate preview to rebuild the text.");
    return;
  }
  renderAiReviewPreview(false);
}

function updateAiPresetDescription() {
  const preset = AI_PRESETS[el.aiPresetSelect.value];
  el.aiPresetDescription.textContent = preset?.description || "";
}

function renderAiReviewPreview(force) {
  if (!force && state.aiReviewDirty) return;
  el.aiReviewPreview.value = buildAiReviewText({
    presetId: el.aiPresetSelect.value,
    includeGuardrails: el.aiGuardrailsInput.checked,
    customInstructions: el.aiCustomInstructions.value,
  });
  state.aiReviewDirty = false;
  setExportStatus("");
}

async function copyAiReviewPreview() {
  try {
    await clipboardAdapter(el.aiReviewPreview.value);
    setExportStatus("Copied AI review text to clipboard.", "success");
  } catch (err) {
    console.warn("AI review copy failed", err);
    el.aiReviewPreview.focus();
    el.aiReviewPreview.select();
    setExportStatus("Copy failed. Text selected; press Cmd+C to copy.", "error");
  }
}

function buildAiReviewText({ presetId = "gaps", includeGuardrails = true, customInstructions = "" } = {}) {
  const lines = ["# Reasoning Notepad AI Review", ""];
  const instructions = [];
  if (includeGuardrails) instructions.push(AI_GUARDRAILS);
  const preset = AI_PRESETS[presetId]?.instruction || "";
  if (preset.trim()) instructions.push(preset.trim());
  if (customInstructions.trim()) instructions.push(customInstructions.trim());

  if (instructions.length) {
    lines.push("## AI Instructions", "");
    instructions.forEach((instruction, index) => {
      if (index > 0) lines.push("");
      lines.push(instruction);
    });
    lines.push("");
  }

  lines.push("## Context", "");
  lines.push(`Title: ${state.session.title || "Untitled"}`);
  if (state.session.goal?.trim()) lines.push(`Goal: ${state.session.goal.trim()}`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push("");

  const scratchPad = state.session.scratchPad?.trim();
  if (scratchPad) {
    lines.push("## Scratch Pad / Rough Material", "", scratchPad, "");
  }

  lines.push("## User Notes", "");
  lines.push("These are user-written notes. Do not treat missing facts as known.");
  lines.push("");
  lines.push("## Entries", "");

  const entries = [...state.session.entries].sort((a, b) => (a.order || 0) - (b.order || 0));
  const groups = [
    ...MARKERS.map((marker) => ({ id: marker.id, label: markerLabel(marker.id) })),
    { id: null, label: "Unmarked" },
  ];

  groups.forEach((group) => {
    const groupEntries = entries.filter((entry) => group.id ? entry.markerId === group.id : !entry.markerId);
    if (!groupEntries.length) return;
    lines.push(`### ${group.label}`, "");
    groupEntries.forEach((entry) => {
      lines.push(`#### ${entry.title || "Untitled entry"}`, "");
      if (entry.body?.trim()) {
        lines.push("Notes:", entry.body.trim(), "");
      }
      if (entry.source?.trim()) {
        lines.push("Reference:", entry.source.trim(), "");
      }
      if (!entry.body?.trim() && !entry.source?.trim()) {
        lines.push("Notes:", "", "");
      }
    });
  });

  return lines.join("\n").trim() + "\n";
}

// ---- Notes view ----

function openNotesView() {
  const item = selectedEntry();
  if (!item) return;
  if (state.editingRowId) commitInlineEdit(state.editingRowId);
  if (state.detailOpen) closeDetail();
  state.notesViewOpen = true;
  el.notesView.classList.remove("hidden");
  document.getElementById("appShell").classList.add("notes-active");
  renderNotesView();
  // Focus body for immediate writing/pasting
  requestAnimationFrame(() => {
    el.notesViewBody.focus();
    const len = el.notesViewBody.value.length;
    el.notesViewBody.setSelectionRange(len, len);
  });
}

function closeNotesView() {
  state.notesViewOpen = false;
  el.notesView.classList.add("hidden");
  document.getElementById("appShell").classList.remove("notes-active");
}

function renderNotesView() {
  if (!state.notesViewOpen) return;
  const item = selectedEntry();
  if (!item) { closeNotesView(); return; }
  el.notesViewTitle.value = item.title || "";
  el.notesViewBody.value = item.body || "";
  el.notesViewSource.value = item.source || "";
  renderNotesViewMeta();
}

// Meta strip rebuilds on source edit so the header reflects the current value
// without forcing a full re-render of the textarea (which would steal cursor).
function renderNotesViewMeta() {
  const item = selectedEntry();
  if (!item) return;
  const parts = [
    item.markerId ? markerLabel(item.markerId) : "",
    item.source?.trim(),
    shouldShowTimestamps() && item.createdAt ? formatTimestamp(item.createdAt) : "",
  ].filter(Boolean);
  el.notesViewMeta.textContent = parts.join(" · ");
}

// ---- Detail panel ----

function openDetail() {
  state.detailOpen = true;
  el.detailPanel.classList.remove("hidden");
  renderDetail();
}

function closeDetail() {
  state.detailOpen = false;
  el.detailPanel.classList.add("hidden");
  el.deleteConfirm.classList.add("hidden");
  el.deleteEntryBtn.classList.remove("hidden");
}

function renderDetail() {
  if (!state.detailOpen) {
    el.detailPanel.classList.add("hidden");
    el.deleteConfirm.classList.add("hidden");
    el.deleteEntryBtn.classList.remove("hidden");
    return;
  }
  el.detailPanel.classList.remove("hidden");
  const item = selectedEntry();
  if (!item) { closeDetail(); return; }

  el.detailPanelTitle.textContent = item.title || "Untitled entry";

  updateDetailStatus();
  el.detailPanelTimestamp.textContent = shouldShowTimestamps() && item.createdAt ? formatTimestamp(item.createdAt) : "";

  el.detailTitleInput.value = item.title || "";
  el.detailBodyInput.value = item.body || "";
  el.detailSourceInput.value = item.source || "";

  renderDetailMarker();

  el.deleteConfirm.classList.add("hidden");
  el.deleteEntryBtn.classList.remove("hidden");
}

function updateDetailStatus() {
  const item = selectedEntry();
  if (!item) return;
  const parts = [item.markerId ? markerLabel(item.markerId) : "", item.source?.trim()].filter(Boolean);
  el.detailPanelStatus.textContent = parts.join(" · ");
}

function renderDetailMarker() {
  const item = selectedEntry();
  if (!item) return;

  el.markerSegmented.innerHTML = MARKERS.map((m) => `
    <button type="button" class="marker-seg-btn${item.markerId === m.id ? " active" : ""}" data-marker="${m.id}">
      <span class="marker-seg-glyph">${m.glyph}</span>${escapeHtml(markerLabel(m.id))}
    </button>
  `).join("");

  el.markerSegmented.querySelectorAll(".marker-seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const newMarker = btn.dataset.marker;
      const toggling = item.markerId === newMarker;
      setSelectedMarker(toggling ? null : newMarker);
      renderDetailMarker();
      updateDetailStatus();
    });
  });

  el.clearMarkerBtn.classList.toggle("hidden", !item.markerId);
  el.clearMarkerBtn.onclick = () => {
    setSelectedMarker(null);
    renderDetailMarker();
    updateDetailStatus();
  };
}

function renderFooter() {
  const visible = filteredEntries();
  const total = state.session.entries.length;
  let summary = `${visible.length} entr${visible.length === 1 ? "y" : "ies"}`;
  if (state.filter !== "All") {
    const marker = MARKERS.find((m) => m.id === state.filter);
    let filterLabel = marker ? markerLabel(marker.id) : null;
    if (!filterLabel) {
      if (state.filter === "unlabeled") filterLabel = "Unlabeled";
      else if (state.filter === "has-source") filterLabel = "Has ref";
      else filterLabel = "No ref";
    }
    summary += ` · ${filterLabel}`;
  }
  if (state.search) summary += ` · "${state.search}"`;
  el.footerSummary.textContent = summary;
}

// ---- Timestamp formatting ----

function formatTimestamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const sameYear = d.getFullYear() === now.getFullYear();

  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return timeStr;

  const monthDay = d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (sameYear) return `${monthDay}, ${timeStr}`;

  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) + `, ${timeStr}`;
}

// ---- Utilities ----

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

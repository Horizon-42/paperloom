// data 模块的界面文案（英文）。结构必须与 zh/data.ts 一致，由类型检查保证。
import type { Messages } from "../zh";

/** "once"、"3 times" */
const times = (n: number) => (n === 1 ? "once" : `${n} times`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TABLES: Record<string, [string, string]> = {
  domains: ["field", "fields"],
  papers: ["paper", "papers"],
  annotations: ["annotation", "annotations"],
  terms: ["term", "terms"],
  links: ["link", "links"],
  notes: ["note", "notes"],
  boards: ["canvas", "canvases"],
  boardNodes: ["canvas node", "canvas nodes"],
  kv: ["setting", "settings"],
};

const andList = (items: readonly string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const data: Messages["data"] = {
  status: {
    probing: "Connecting to local service…",
    offline: "No local service · Browser only",
    offlineRemind: (days) => `Browser only · No backup in ${plural(days, "day")}`,
    restoring: (dir) => `Restoring from ${dir}…`,
    saving: "Saving…",
    localEmpty: "Browser data was cleared · Auto-save paused",
    newerFormat: (dir) => `Data in ${dir} is from a newer version · Auto-save paused`,
    dbReset: "Local database was reset · Auto-save paused",
    unreadable: (dir) => `Can't read ${dir}library.json · Auto-save paused`,
    revision: "Folder data was updated by another window",
    saveFailed: "Save failed",
    needsMigration: "Data needs migration to projects · Auto-save paused",
    savedTo: (dir) => `Saved to ${dir}`,
    pdfUpload: "Saving PDFs",
    pdfFetch: "Fetching PDFs",
    buttonTitle: (dir) => (dir ? `Data & backup (${dir})` : "Data & backup"),
    closeNotice: "Dismiss",
  },
  browserOnly: {
    heading: "Your data is saved only in this browser",
    body: "Papers and annotations are never uploaded to a server, but you'll lose access to them if you clear site data or switch browsers or computers. Export a backup regularly. Backups don't include the PDF files themselves, so keep your originals.",
    exportBackup: "Export backup",
    dismiss: "Got it",
  },
  strayLegacy: {
    files: (shown, total) => shown.join(", ") + (total > shown.length ? ` and ${total - shown.length} more` : ""),
    heading: (files) => `Files written by an older version are in the data/ root: ${files}`,
    body: "An older version was probably started after the migration to projects. This version doesn't read these files. If you made changes in the older version, import data/library.json under “Data & backup” (your current data is backed up first). Once you're sure you don't need them, move these files out of data/ (e.g. to data-backup-before-projects-leftovers/).",
    hide: "Hide for now",
  },
  dialog: {
    title: "Data & backup",
    description: "Auto-save status, export and import backups",
    autoSave: {
      title: "Auto-save",
      probing: "Connecting to local service…",
      needsMigration: "Your data needs to be migrated to projects: run {cmd}. Nothing is written to {dir} until then, and the data in this browser is safe.",
      offlineWarning:
        "No local service: data is saved only in this browser. Clearing browser data (or opening Paperloom at another address or port) will make it disappear.",
      offlineHowTo: "When Paperloom is started with {cmd}, data is saved automatically to the project's {dir} folder. Without the local service, export a JSON backup every week.",
      lastExport: (when) => `Last backup export: ${when}`,
      neverExported: "never",
      exportNow: " (export one now)",
      onlineInfo:
        "Data is saved automatically to {dir}: {library} holds all notes and annotations, {pdfs} the original PDFs, and {backups} hourly rolling history. If browser data is cleared, Paperloom restores from here when opened.",
      lastSaved: (when) => `Last saved ${when}`,
      saving: "Saving…",
      restoring: "Restoring…",
      paused: "Auto-save paused: the folder and this browser have different data. Choose which to keep in the prompt.",
      pdfUpload: "Saving PDFs",
      pdfFetch: "Fetching PDFs from data/pdfs",
      missingPdfs: (n) =>
        `${plural(n, "PDF file")} can't be found in this browser or data/pdfs. Import the file again when you open the paper.`,
      failedUploads: (n) =>
        `${plural(n, "PDF")} couldn't be saved to data/pdfs (rejected by the local service; see the browser console). ${n === 1 ? "It's" : "They're"} still saved in this browser.`,
      saveNow: "Save now",
      usage: (u) =>
        `Disk usage ${u.total}: library.json ${u.library}, pdfs/ ${u.pdfs}, backups/ ${u.backups}` +
        (u.trash ? `, trash/ ${u.trash}` : "") +
        (u.groups?.length ? `, ${u.groups.join(", ")}` : ""),
    },
    export: {
      title: "Export",
      exporting: "Exporting…",
      json: "Export JSON backup",
      regenerateMarkdown: "Regenerate Markdown",
      markdown: "Export Markdown",
      downloaded: (name) => `Downloaded ${name}`,
      updated: (path) => `Updated ${path}/`,
      failed: (reason) => `Export failed: ${reason}`,
      jsonNote: "A JSON backup includes all paper info, annotations, terms, canvases and settings, but not PDF files.",
      markdownFolder: "Markdown (one file per term and per paper, ready for Obsidian) is generated automatically in {dir}{last}.",
      lastGenerated: (when) => `, last generated ${when}`,
      markdownCombined: "Markdown is exported as a single combined .md file (terms and annotations).",
      markdownFailed: (reason) => `Markdown generation failed: ${reason}`,
    },
    import: {
      title: "Import backup",
      intro: "Restore from a JSON backup. This replaces all data in this browser.",
      reading: "Reading…",
      importing: "Importing…",
      choose: "Choose JSON file…",
      contains: (c) =>
        `Contains ${andList([
          plural(c.papers, "paper"),
          plural(c.terms, "term"),
          plural(c.annotations, "annotation"),
          plural(c.boards, "canvas", "canvases"),
          ...(c.domains ? [plural(c.domains, "field")] : []),
        ])}`,
      exportedAt: (when) => ` (exported ${when})`,
      warnOnline: (dir) => `Importing replaces all data in this browser. Your current data is backed up to ${dir}/backups/ first.`,
      warnOffline: "Importing replaces all data in this browser. There's no local service, so download a backup of your current data first and make sure it's saved.",
      downloadAgain: "Download backup again",
      downloadFirst: "Step 1: Download a backup of current data",
      savedConfirm: (name) => `I've saved ${name}`,
      replace: "Replace current data",
      backedUpTo: (path) => `Previous data backed up to ${path}`,
      downloadedAs: (name) => `Previous data downloaded as ${name}`,
      pdfsNeeded: "PDFs that aren't in this browser need to be imported again (with the local service they're fetched from data/pdfs automatically)",
      done: (c) => `Imported ${andList([plural(c.papers, "paper"), plural(c.terms, "term"), plural(c.annotations, "annotation")])}`,
      failed: (reason) => `Import failed: ${reason}`,
      downloadFailed: (reason) => `Backup download failed: ${reason}`,
    },
  },
  conflict: {
    title: {
      revision: "Folder data was updated by another window",
      localEmpty: "This browser's data was cleared",
      newerFormat: (dir) => `Data in ${dir} is from a newer version of Paperloom`,
      dbReset: "Local database was reset",
      unreadable: (dir) => `Can't read ${dir}library.json`,
    },
    recoverBackup: "Restore from the latest readable backup",
    loadFolder: "Load folder data (replaces this browser's data)",
    restoreFrom: (dir) => `Restore from ${dir} (replaces this browser's data)`,
    clearFolder: (dir) => `Clear the data in ${dir}`,
    writeCurrent: (dir) => `Write current data to ${dir} (backed up first)`,
    overwriteDamaged: "Overwrite with this browser's data (damaged file backed up first)",
    overwriteFolder: "Overwrite folder with this browser's data",
    saving: "Saving…",
    loading: "Loading…",
    gotIt: "Got it",
    later: "Decide later",
    revisionBody:
      "Another window (e.g. Paperloom opened at a different address or port) saved data to {dir}, and this browser also has unsaved changes. Auto-save is paused; choose which version to keep.",
    backupNote: "The version being replaced is backed up to {dir}backups/ first.",
    localEmptyBody: "This browser no longer has any papers, annotations or terms (browser data may have been cleared), but {dir} still has data.",
    localEmptyNote: "If you deleted everything on purpose, you can clear the folder's data too (it's backed up to {dir}backups/ first).",
    newerFormatBody: "Update Paperloom before opening it. Until then nothing is written to {dir}, and your changes stay saved in this browser.",
    dbResetBody:
      "This browser's database was cleared and recreated (e.g. browser data was cleared), so it only has content created since. Auto-save is paused so this partial data doesn't overwrite the full library in {dir}.",
    dbResetNote: "Either way, the version being replaced is backed up to {dir}backups/ first.",
    unreadableBody: "{dir}library.json can't be parsed (another program may have damaged it). Auto-save is paused and won't overwrite it with this browser's data.",
    unreadableNote:
      "You can replace it with the latest readable version from {dir}backups/ (this browser's data is backed up first), or overwrite it with this browser's data (the damaged file is kept aside).",
  },
  migration: {
    title: "Data needs migration to projects: run npm run migrate:projects",
    oldLayout: (dir) => `${dir} still uses the old folder layout. The new version keeps each project's data in data/projects/<project>/, and your existing data becomes the first project.`,
    howTo: "In the app folder, run {preview} to preview, then {apply} to migrate (data/ is fully backed up first).",
    paused: "Auto-save is paused until the migration is done; nothing is written to data/ and the data in this browser is safe. Reload this page after migrating to continue.",
    reload: "Migrated, reload page",
  },
  sync: {
    counts: (c) =>
      andList([
        plural(c.papers ?? 0, "paper"),
        plural(c.terms ?? 0, "term"),
        plural(c.annotations ?? 0, "annotation"),
        ...(c.boards ? [plural(c.boards, "canvas", "canvases")] : []),
      ]),
    restoreFailed: (dir, reason) => `Restoring from ${dir} failed: ${reason} (reload the page to retry)`,
    shrinkBackup: (name) => `Data shrank by more than half since the last save; the previous version was backed up as backups/${name}`,
    saveFailed: (reason) => `Save failed: ${reason} (will retry automatically)`,
    restoring: (dir) => `Restoring data from ${dir}…`,
    pdfsLater: "PDFs are read from data/pdfs when opened and fetched in the background",
    loadedFromOtherWindow: (counts) => `Loaded data saved by another window: ${counts}`,
    restoredFromBackup: (name, counts) => `Restored from backup ${name}: ${counts}`,
    restoredFrom: (dir, counts) => `Restored from ${dir}: ${counts}`,
    folderChangedAgain: "The folder was updated again in the meantime; please choose again",
    ownerNoResponse: "The tab responsible for saving isn't responding",
  },
  format: {
    invalidJson: "Not a valid JSON file",
    notPaperloom: "This isn't a Paperloom backup file",
    missingVersion: "The backup file has no valid data format version",
    newerVersion: (version, supported) =>
      `This data is from a newer version of Paperloom (data format v${version}; this version supports up to v${supported}). Please update the app first`,
    missingTables: "The backup file has no data tables",
    unreadableFile: "Can't read the file (not a valid JSON or gzip file)",
    untitledPaper: "Untitled paper",
    untitledBoard: "Untitled canvas",
    skipped: (n, table) => {
      const [one, many] = TABLES[table] ?? [table, table];
      return `Skipped ${plural(n, `invalid or orphaned ${one}`, `invalid or orphaned ${many}`)}`;
    },
    mergedPapers: (n) => `Merged ${plural(n, "duplicate paper")}`,
    annotationTermMissing: (n) => `Unlinked ${plural(n, "annotation")} from terms that no longer exist`,
    termSourceMissing: (n) => `Cleared the source of ${plural(n, "term")} whose source annotation no longer exists`,
    changedSinceBackup: "Local data changed after the backup was downloaded. Download a new backup, then import again",
    downloadBackupFirst: "Download a backup of your current data first",
    localChanged: "Local data changed while loading; loading was canceled",
  },
  errors: {
    cannotConnect: "Can't connect to the local service",
    httpStatus: (status) => `Local service returned ${status}`,
    pdfCorrupt: "A file in data/pdfs is damaged (hash mismatch)",
    noLibrary: "There's no library.json in data/",
    server: {
      "not-loopback": "Only requests from this computer are accepted",
      preflight: "Cross-origin requests aren't supported",
      "bad-host": "Host isn't a local address",
      "bad-origin": "Requests from other websites aren't accepted",
      "cross-site": "Requests from other websites aren't accepted",
      "missing-header": "Missing X-PaperLens request header",
      "invalid-client": "Missing a valid X-PaperLens-Client header",
      "too-large": () => "The request or file is too large",
      "invalid-json": "Not valid JSON",
      gone: "This endpoint is no longer used (data is now stored per project): please reload the page",
      method: "Method not supported",
      "not-found": () => "Not found",
      "unknown-project": "Project not found",
      "invalid-project": "Invalid project ID",
      "invalid-revision": (d) => {
        const rev = d.data?.revision;
        return typeof rev === "number" ? `Invalid revision: expected ${rev + 1}` : "Missing or invalid revision";
      },
      "invalid-format": () => "Not a valid Paperloom data file",
      unreadable: "data/library.json can't be read (it may be damaged) and won't be overwritten directly",
      conflict: "Folder data was updated by another window",
      "newer-format": "Folder data was written by a newer version of Paperloom and can't be overwritten by this version",
      "no-backup": "No readable backup found",
      readable: "library.json can be read normally; there's no need to restore from a backup",
      "invalid-reason": "A backup reason may contain only lowercase letters, digits and hyphens, and must start with a letter",
      "invalid-hash": "Invalid file hash",
      "hash-mismatch": "File content doesn't match its hash",
      "invalid-group": "Invalid file group name",
      "invalid-files": "files must be an array",
      "invalid-name": () => "Invalid name",
      "duplicate-name": () => "Duplicate file name",
      busy: () => "The data folder is busy; please try again shortly",
      "registry-unreadable": () => "data/projects.json can't be read",
      "project-dir-missing": () => "The project folder doesn't exist",
      exists: () => "This project already exists",
      "last-project": "The last project can't be deleted",
      "project-active": () =>
        "This project is open in another window (possibly at another address or in another browser). Close it first; if you just closed it, wait a minute and try again",
      "needs-migration": "data/ still uses the old folder layout and must be migrated to projects first: run npm run migrate:projects",
      internal: (d) => (d.message ? `Local service error: ${d.message}` : "Local service error"),
    },
  },
  markdown: {
    field: (label, value) => `${label}: ${value}`,
    list: (items) => items.join(", "),
    authorList: (items) => items.join("; "),
    longList: (items) => items.join("; "),
    pages: (pages, more) => pages.join(", ") + (more ? ", …" : ""),
    aliases: "Aliases",
    scope: "Scope",
    domainDeleted: "(field deleted)",
    noNote: "_(No notes yet)_",
    appearsIn: "Appears in",
    notFoundYet: "_(Not found in the library yet)_",
    occurrences: (count, pages) => `${times(count)} (${pages.includes(",") ? "pp." : "p."} ${pages})`,
    countIn: (title, count) => `${title} (${times(count)})`,
    orphaned: "_(Passage not found after the PDF was replaced)_",
    term: "Term",
    authors: "Authors",
    year: "Year",
    domains: "Fields",
    tags: "Tags",
    pageCount: "Pages",
    doi: "DOI",
    citations: "Cited by",
    citationsValue: (count, date) => `${count} (OpenAlex, ${date})`,
    annotations: (n) => `Annotations (${n})`,
    noAnnotations: "_(No annotations yet)_",
    page: (n) => `Page ${n}`,
    readme: `# Paperloom notes

This folder is generated by Paperloom and updated on every save:

- \`terms/\`: one file per term (aliases, scope, notes, and the papers it appears in)
- \`papers/\`: one file per paper (metadata and all annotations)

Changes made here are overwritten on the next save, so edit in Paperloom instead. You can open this folder as an Obsidian vault.
`,
    combinedTitle: "Paperloom export",
    combinedSummary: (date, terms, papers) => `Exported ${date}; ${plural(terms, "term")}, ${plural(papers, "paper")}.`,
    terms: "Terms",
    noTerms: "_(No terms)_",
    papersAndAnnotations: "Papers & annotations",
    noPapers: "_(No papers)_",
  },
};

export default data;

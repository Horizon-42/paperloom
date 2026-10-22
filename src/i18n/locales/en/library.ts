// library 模块的界面文案（英文）。结构必须与 zh/library.ts 一致，由类型检查保证。
import type { Messages } from "../zh";
import common from "./common";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const papers = (n: number) => plural(n, "paper");
const q = common.quote;

const library: Messages["library"] = {
  sidebar: {
    ariaLabel: "Library",
    importTitle: "Import PDFs (or drop them onto the window)",
    importButton: "Import",
    viewsLabel: "Main view",
    views: { reader: "Read", glossary: "Glossary", annotations: "Annotations", canvas: "Canvas" },
    resizeLabel: "Resize sidebar (double-click to reset)",
    dropToImport: "Drop to import PDFs",
    dropInto: (domain) => `They will be added to ${q(domain)}`,
  },

  search: {
    placeholderPapers: "Search titles, authors, tags",
    // 侧栏窄：三组以上时不逐一列出
    placeholder: (groups) => (groups.length > 2 ? "Search all (#tag)" : `Search ${common.list(groups.map((g) => g.toLowerCase()))} (#tag)`),
    title: "Search paper titles, authors and tags. Start with # to search tags only, e.g. #to-read",
    ariaLabel: "Search",
    clear: "Clear search",
    results: "Search results",
    resultCount: (n) => plural(n, "result"),
    noMatch: (query) => `Nothing matches ${q(query)}`,
    showingFirst: (n) => ` (showing first ${n})`,
    paperGroup: "Papers",
  },

  domains: {
    navLabel: "Fields",
    all: "All papers",
    unfiled: "Unfiled",
    newDomain: "New field",
    treeLabel: "Field tree",
    empty: "No fields yet. Click + to create one, then drag papers onto it to file them.",
    dropToRoot: "Drop here to move to top level",
    collapse: "Collapse",
    expand: "Expand",
    newSubdomain: "New subfield",
    more: "More",
    actions: "Field actions",
    changeColor: "Change color",
    nameLabel: "Field name",
    color: "Color",
    deleteDomain: "Delete field…",
    defaultName: "New field",
    colors: {
      blue: "Blue",
      green: "Green",
      amber: "Amber",
      red: "Red",
      purple: "Purple",
      cyan: "Cyan",
      pink: "Pink",
      orange: "Orange",
      lime: "Lime",
      indigo: "Indigo",
      gray: "Gray",
    },
  },

  paperList: {
    ariaLabel: "Paper list",
    noTagged: (tags) => (tags.length === 1 ? `No papers tagged ${q(tags[0])}.` : "No papers have all of these tags."),
    clearTagFilter: "Clear tag filter",
    emptyLibrary: "Your library is empty. Click “Import” above to choose PDFs, or drop PDFs onto the window.",
    noPapers: "No papers.",
    tagFilterBar: "Tag filter",
    clear: "Clear",
    filterByTag: "Filter by tag",
    filterByTagCount: (n) => `Filter by tag (${n} selected)`,
    filterAllHint: " (papers with all selected tags)",
    manageTags: "Manage tags…",
    sortLabel: (label) => `Sort: ${label}`,
    sortHeading: "Sort by",
    sort: { added: "Date added", title: "Title", year: "Year", lastOpened: "Last opened" },
  },

  paperRow: {
    unknownAuthors: "Unknown authors",
    domains: (names) => `Fields: ${common.list(names)}`,
    editTags: "Edit tags (T)",
    authorsEtAl: (shown) => `${shown} et al.`,
  },

  paperMenu: {
    open: "Open",
    editInfo: "Edit info…",
    tags: "Tags…",
    replacePdf: "Replace PDF file…",
    removeFromDomain: (name) => `Remove from ${q(name)}`,
    addToDomain: "Add to field",
    noDomains: "No fields yet",
    deletePaper: "Delete paper…",
  },

  movePaper: {
    moved: (name) => `Moved to ${q(name)}`,
    removedFrom: (name) => `Removed from ${q(name)}`,
    movedToUnfiled: "Moved to Unfiled",
  },

  tree: {
    viewLabel: "Paper view",
    byField: "By field",
    all: "All",
    alsoIn: (paths) => `Also in: ${paths.join("; ")}`,
  },

  editPaper: {
    title: "Edit paper info",
    yearInvalid: "Year must be four digits",
    titleRequired: "Title can't be empty",
    titleLabel: "Title",
    authorsLabel: "Authors",
    authorsHint: "(separate with commas or semicolons)",
    authorsPlaceholder: "Jane Doe, John Smith",
    yearLabel: "Year",
    tagsLabel: "Tags",
    tagsHint: "(Enter or comma to add)",
    tagsPlaceholder: "e.g. to-read, survey",
    domainsLabel: "Fields",
    selectedCount: (n) => `${n} selected`,
    removeDomain: (name) => `Remove ${name}`,
    noDomains: "No fields yet. You can create them in the sidebar.",
    filterDomains: "Filter fields",
    noMatchingDomains: "No matching fields",
    footer: (pages, date) => `${plural(pages, "page")} · Added ${date}`,
  },

  deletePaper: {
    title: "Delete paper?",
    body: (annotationCount) =>
      `This also deletes the paper's PDF file, ${annotationCount ? plural(annotationCount, "annotation") : "its annotations"}, term occurrences, and any links and canvas nodes pointing to the paper or its annotations. Terms themselves are kept. This can't be undone.`,
    confirm: "Delete paper",
  },

  deleteDomain: {
    title: (name) => `Delete field ${q(name)}?`,
    descendants: (n) => `Its ${plural(n, "subfield")} will also be deleted`,
    papers: (n) => (n > 0 ? `${papers(n)} will be removed from these fields` : "No papers in these fields"),
    papersNote: " (the papers themselves are not deleted)",
    terms: (n) => `${plural(n, "term")} will have these fields removed from their scope`,
    termsNote: " (a term whose scope becomes empty won't apply to any paper)",
    confirm: "Delete field",
  },

  tags: {
    groupLabel: "Tags",
    remove: (tag) => `Remove tag ${q(tag)}`,
    filterBy: (tag) => `Filter by ${q(tag)}`,
    unfilter: (tag) => `Stop filtering by ${q(tag)}`,
    noTags: "No tags yet. Press T on a paper, or right-click it and choose “Tags…”.",
    emptyName: "Tag name can't be empty",
    control: {
      label: (tags) => `Tags: ${common.list(tags)} (T to edit)`,
      add: "Add tags (T)",
      addShort: "Add tags",
    },
    editor: {
      ariaLabel: "Edit tags",
      heading: "Tags",
      inputLabel: "Add tag",
      hint: "Enter to add · commas for several · Esc to close",
    },
    input: {
      placeholder: "Add tag…",
      suggestions: "Tag suggestions",
      existing: "Existing tags",
      create: "Create tag “{tag}”",
      already: (tag) => `${q(tag)} is already added`,
      allAdded: "All tags in the library are already added. Type a new tag and press Enter.",
      emptyHint: "Type a tag and press Enter. Separate with commas to add several at once.",
      backspaceAgain: (tag) => `Press Backspace again to remove tag ${q(tag)}`,
    },
    manage: {
      title: "Manage tags",
      summary: (n) =>
        `${plural(n, "tag")}. Renaming a tag to an existing name merges the two. Deleting only removes the tag from papers; the papers are kept.`,
      listLabel: "All tags",
      done: "Done",
      merged: (from, to, n) => `Merged ${q(from)} into ${q(to)} (${papers(n)})`,
      renamed: (from, to, n) => `Renamed ${q(from)} to ${q(to)} (${papers(n)})`,
      deleted: (tag, n) => `Removed tag ${q(tag)} from ${papers(n)}`,
      newNameLabel: (tag) => `New name for ${q(tag)}`,
      merge: "Merge",
      mergeHint: (name, n) => `Tag ${q(name)} already exists (${papers(n)}). Saving will merge the two.`,
      deleteConfirm: (n) => `Remove “{tag}” from ${papers(n)}?`,
      keepPapers: " Papers aren't deleted.",
      count: (n) => papers(n),
      renameLabel: (tag) => `Rename ${q(tag)}`,
      deleteLabel: (tag) => `Delete ${q(tag)}`,
    },
  },

  importStatus: {
    added: "Added",
    duplicate: "Duplicate",
    failed: "Failed",
    addedCount: (n) => `${n} added`,
    duplicateCount: (n) => plural(n, "duplicate"),
    failedCount: (n) => `${n} failed`,
    close: "Close import results",
    showDetails: "Show details",
    hideDetails: "Hide details",
    alreadyInLibrary: (title) => `already in library${title ? `: ${title}` : ""}`,
    oneDuplicate: (name) => `${q(name)} is already in the library`,
    oneAdded: "Imported 1 paper",
    oneFailed: "Import failed",
    allDuplicates: "These papers are all already in the library",
    done: "Import complete",
    progress: (current, total) => `Importing ${current}/${total}`,
  },

  importErrors: {
    encrypted: "Encrypted PDFs aren't supported yet",
    corrupt: "The file is damaged or not a valid PDF",
    unreadable: "Couldn't read the file",
    notPdf: "Not a PDF file",
    noPages: "The PDF has no pages",
    unknown: "Unknown error",
    untitled: "Untitled paper",
  },

  projects: {
    defaultName: "My project",
    switcherTitle: (name) => `Project: ${name} (click to switch)`,
    switcherAria: (name) => `Current project: ${name}. Switch project`,
    menuHeading: "Projects",
    menuLocalNote: " (local service not connected: list is saved in this browser only)",
    menuErrorNote: " (the local service's project list can't be read right now)",
    browserOnly: "This browser only",
    openInNewTab: "Open in new tab",
    openNameInNewTab: (name) => `Open ${q(name)} in new tab`,
    newProject: "New project…",
    renameCurrent: "Rename current project…",
    manage: "Manage/delete projects…",
    registryError: (error) => `Can't read the local service's project list: ${error ?? ""}`,
    registryErrorHelp:
      "Only the data in this browser can be used for now; creating, renaming and deleting projects is disabled. Check data/projects.json, then reload the page.",
    create: {
      title: "New project",
      descServer: "Each project keeps its own papers, annotations, terms and canvases, saved in its own folder under data/projects/.",
      descLocal:
        "Local service not connected: the new project is saved in this browser only (its folder is created automatically the next time you start with npm run dev).",
      nameLabel: "Project name",
      namePlaceholder: "e.g. RoFormer deep dive",
      openInNewTab: "Open in a new tab (keep this tab as is)",
      creating: "Creating…",
      submit: "Create and open",
    },
    rename: {
      title: "Rename current project",
      note: (id) => `Only the display name changes; the folder data/projects/${id}/ stays the same.`,
    },
    manageDialog: {
      title: "Manage projects",
      current: "Current",
      browserLocation: (id) => `This browser · ${id}`,
      open: "Open",
      newTab: "New tab",
      delete: "Delete…",
      deleteKeepBrowser: "Delete anyway (keep this browser's database)",
      deleting: "Deleting…",
      deleteProject: "Delete project",
      currentNote: "The open project can't be deleted. To delete it, switch to another project first.",
      deleteFailed: (reason) => `Delete failed: ${reason}`,
      confirmServer: (name) =>
        `${q(name)} and its papers, annotations, terms and canvases will be removed from the project list. The data is moved to data/trash/projects/, not permanently deleted. Once everything in this browser is confirmed saved to the folder, this browser's database for it is deleted too.`,
      confirmListOnly: (name) =>
        `Local service not connected: ${q(name)} will only be removed from this browser's project list. Its folder and this browser's database are kept.`,
      confirmLocal: (name) =>
        `${q(name)} exists only in this browser. A JSON backup (without PDF files) will be downloaded first, then all of its data in this browser is deleted.`,
      result: {
        listOnly: (name) =>
          `Removed ${q(name)} from this browser's project list (local service not connected: its folder and this browser's database are kept).`,
        trashed: (name, path) => `Deleted ${q(name)}. Its folder was moved to data/${path}/.`,
        deleted: (name) => `Deleted ${q(name)}.`,
        exported: (file) => `A backup was downloaded first: ${file}.`,
        kept: "Its database in this browser was kept (open the project's address to export it).",
        blocked: "Its database in this browser is in use and wasn't deleted (other projects are not affected).",
        failed: "Its database in this browser couldn't be deleted (other projects are not affected).",
        join: (parts) => parts.join(" "),
      },
    },
    errors: {
      nameRequired: "Enter a project name",
      nameTooLong: (max) => `Project names can be at most ${max} characters`,
      nameControlChars: "Project names can't contain control characters",
      noResponse: "The local service isn't responding",
      listUnavailable: (reason) =>
        `The local service's project list can't be read right now (${reason ?? "unknown error"}). Fix this, then reload the page.`,
      needsMigration: "The data must be migrated to the project layout first",
      notFound: "Project not found",
      deleteCurrent: "The open project can't be deleted",
      deleteLast: "The last project can't be deleted",
      openElsewhere: (name) => `${q(name)} is open in another tab. Close those tabs before deleting it.`,
      unsynced: (name, detail) =>
        `${q(name)} has content in this browser that isn't saved to its folder yet (${detail}); deleting would lose it. Open the project and wait until the bottom-left corner shows “Saved”, then delete it.`,
      cannotVerify: "Can't reach the local service, so it can't be confirmed that the folder has all the data",
      libraryMismatch: "library.json in the folder differs from this browser's data; there may be unsaved changes",
      noLibrary: "there is no library.json in the folder yet",
      pdfsMissing: (n) => `${plural(n, "PDF")} not yet saved to the folder`,
    },
  },
};

export default library;

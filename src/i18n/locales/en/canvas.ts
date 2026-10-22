// canvas 模块的界面文案（英文）。结构必须与 zh/canvas.ts 一致，由类型检查保证。
import type { Messages } from "../zh";

const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const links = (n: number) => s(n, "link", "links");
const cards = (n: number) => s(n, "card", "cards");

const canvas: Messages["canvas"] = {
  defaultBoardName: "Untitled canvas",
  numberedBoardName: (base, n) => `${base} ${n}`,
  loading: "Loading canvas…",
  join: (items) => items.join(", "),

  relations: {
    supports: "Supports",
    contradicts: "Contradicts",
    extends: "Extends",
    compares: "Compares",
    partOf: "Part of",
    custom: "Custom",
  },

  entity: {
    kinds: {
      annotation: "Annotation",
      term: "Term",
      paper: "Paper",
      note: "Note",
    },
    deleted: {
      annotation: "Deleted annotation",
      term: "Deleted term",
      paper: "Deleted paper",
      note: "Deleted note",
    },
    deletedItem: "Deleted item",
    noQuote: "(no text)",
    emptyNote: "(empty note)",
    unknownPaper: "Unknown paper",
    source: (paper, page) => `${paper} · p. ${page}`,
    etAl: " et al.",
  },

  errors: {
    emptyBoardName: "Canvas name can't be empty",
    boardMissing: "Canvas not found",
    entityDeleted: "This item has been deleted",
    selfLink: "Can't link an item to itself",
  },

  empty: {
    title: "No canvases yet",
    body: "After reading, organize your annotations on a canvas: drag in annotations, terms and papers, and connect them with links that carry a relation. The same notes can be arranged on several canvases by topic.",
    create: "New canvas",
  },

  noBoardsToast: "No canvases yet. Create one under “Canvas” first.",

  toolbar: {
    switchBoard: "Switch canvas",
    boardsHeading: "Canvases (recently modified first)",
    newBoardMenu: "New canvas…",
    rename: "Rename canvas",
    renameMenu: "Rename…",
    deleteMenu: "Delete canvas…",
    domainsTitle: "Linked fields: the inbox filters by these fields by default",
    domains: "Linked fields",
    domainsHeading: "Fields linked to this canvas",
    noDomains: "No fields yet",
    saveFailed: "Couldn't save",
    nodeCount: (n) => cards(n),
    fitTitle: "Show all cards",
    fit: "Fit",
    exportTitle: "Export as a JSON Canvas file that Obsidian can open",
    export: "Export .canvas",
    exportFailed: "Export failed",
    more: "More actions",
  },

  dialogs: {
    newBoard: "New canvas",
    create: "Create",
    renameBoard: "Rename canvas",
    nameRequired: "Name can't be empty",
    namePlaceholder: "Canvas name, e.g. Method comparison",
    nameLabel: "Canvas name",
    readFailed: "Couldn't read the canvas",
    deleteTitle: (name) => `Delete canvas “${name}”?`,
    deleteBody: (nodes) =>
      `${nodes === 1 ? "The 1 card" : `All ${nodes} cards`} on this canvas will be removed. Annotations, terms, papers and links are not affected; links still show on other canvases and in “Related notes”.`,
    orphanLegend: (n) =>
      n === 1 ? "1 free note is only on this canvas and has no links" : `${n} free notes are only on this canvas and have no links`,
    keepOrphans: "Keep them and move back to “Unsorted”",
    deleteOrphans: "Delete these notes too",
    irreversible: "This can't be undone.",
    deleteConfirm: "Delete canvas",
    deleted: (name, notes) => (notes ? `Deleted canvas “${name}” and ${s(notes, "note", "notes")}` : `Deleted canvas “${name}”`),
    deleteFailed: "Couldn't delete the canvas",
  },

  sidebar: {
    label: "Canvas materials",
    inbox: "Unsorted",
    search: "Search",
    newNoteTitle: "New free note in the center of the canvas (or double-click an empty spot)",
    newNote: "Note",
    scopeLabel: "Inbox scope",
    scopeAnywhere: "Not on any canvas",
    scopeBoard: "Not on this canvas",
    domainFilter: "Filter by field",
    allDomains: "All fields",
    boardDomains: "Fields linked to this canvas",
    paperFilter: "Filter by paper",
    allPapers: "All papers",
    colorFilter: "Filter by color",
    clear: "Clear",
    countAnywhere: (n) => `${n} unsorted`,
    countBoard: (n) => `${n} not on this canvas`,
    dragHint: "Drag onto the canvas",
    hiddenNotes: (n) =>
      n === 1 ? "1 free note is hidden by the paper/color filter" : `${n} free notes are hidden by the paper/color filter`,
    showMore: (more, total) => `Show ${more} more (${total} total)`,
    noMatch: "Nothing matches the filters",
    boardHasAll: "This canvas already has every annotation and note.",
    allPlaced: "All annotations are on a canvas. New annotations you make while reading will show up here; to organize another canvas, switch to “Not on this canvas”.",
    freeNote: "Free note · not on any canvas",
    placeCenter: "Place in the center of the canvas",
    place: "Place on canvas",
    jump: "Go to source",
    searchPlaceholder: "Terms, annotations, papers, notes…",
    searchLabel: "Search for items to add",
    searchHint: "Type a keyword, then drag terms, annotations, whole papers or existing notes onto the canvas.",
    noTerms: "No terms yet",
    noResults: "No matching items",
    recentTerms: "Recent terms",
    locateTitle: "Already on this canvas; click to locate",
    locate: "Locate",
  },

  board: {
    emptyHint: {
      drag: "Drag annotations, terms or papers here from the left,",
      newNote: "or double-click an empty spot to create a note.",
      connect: "Drag a card's edge dot onto another card to link them.",
    },
    alreadyHere: "Already on this canvas; jumped to the card",
    notHere: "That item isn't on this canvas",
    placeFailed: "Couldn't place on the canvas",
    newNoteFailed: "Couldn't create the note",
    savePositionFailed: "Couldn't save the position",
    saveSizeFailed: "Couldn't save the size",
    removed: (n) =>
      n === 1 ? "Removed from the canvas (the item and its links are kept)" : `Removed ${n} cards from the canvas (the items and their links are kept)`,
    removeFailed: "Couldn't remove from the canvas",
    paperNoAnnotations: "This paper has no annotations yet",
    paperAllPlaced: "All annotations of this paper are already on this canvas",
    annotationsAdded: (n) => `Added ${s(n, "annotation", "annotations")}`,
    addAnnotationsFailed: "Couldn't add the annotations",
    noteDeleted: "Note deleted",
    deleteNoteFailed: "Couldn't delete the note",
    linksDeleted: (n) => (n === 1 ? "Link deleted (removed from all canvases)" : `${n} links deleted (removed from all canvases)`),
    linksRestored: (n) =>
      n ? `Restored ${n} of them; the other links lost an endpoint` : "Couldn't restore: an endpoint of the link has been deleted",
    deleteLinksFailed: "Couldn't delete the links",
    linkExists: "This link already exists; selected it",
    createLinkFailed: "Couldn't create the link",
    linkMerged: "Identical to an existing link; merged into one",
    updateLinkFailed: "Couldn't update the link",
    deleteNoteTitle: "Delete this note?",
    deleteNoteBody: (n) =>
      `The note's content will be deleted, along with its card on every canvas${n ? ` and its ${links(n)}` : ""}. To only take it off this canvas, use “Remove from canvas”.`,
    deleteNoteConfirm: "Delete note",
    deleteLinksTitle: (n) => (n === 1 ? "Delete this link?" : `Delete ${n} links?`),
    deleteLinksBody: "Links are global: once deleted, they disappear from all canvases and from “Related notes” in term popups. The items at either end are not affected.",
    deleteLinksConfirm: "Delete link",
  },

  picker: {
    create: "New link",
    edit: "Edit link",
    reverse: "Reverse direction",
    relationGroup: "Relation",
    customPlaceholder: "Relation text (required)",
    notePlaceholder: "Note (optional)",
    labelAria: "Relation text",
    customNeedsText: "A custom relation needs some text",
    deleteButton: "Delete link…",
    submitCreate: "Link",
    deleteTitle: "Delete this link?",
    deleteBody: "This link is global: once deleted, it disappears from {all} and from {related} in term popups. The items at either end are not affected.",
    allBoards: "all canvases",
    relatedNotes: "“Related notes”",
    deleteConfirm: "Delete link",
  },

  edgeTitle: (text) => `${text} (click to edit or delete)`,

  node: {
    externalTitle: (n) => (n === 1 ? "1 more link leads to an item not on this canvas" : `${n} more links lead to items not on this canvas`),
    externalLabel: (n) => `${links(n)} not on this canvas`,
    externalHeading: "Links to items not on this canvas",
    placeHere: "Place on this canvas",
    place: "Place on canvas",
    remove: "Remove from canvas",
    editorHint: "⌘Enter to save · Esc to cancel",
    termSource: "Annotation · term source",
    orphaned: "Unanchored",
    orphanedTitle: "The text can't be found since the PDF file was replaced; jumping only goes to the original page",
    editNote: "Edit note",
    jump: "Go to source",
    annotationPlaceholder: "Write a note (Markdown and $math$ supported)",
    addNote: "Add a note…",
    saveNoteFailed: "Couldn't save the note",
    editTerm: "Edit term",
    noNote: "No notes yet",
    addPaperAnnotations: "Add all annotations of this paper",
    openPaper: "Open paper",
    deleteNote: "Delete note",
    notePlaceholder: "Write something (Markdown and $math$ supported)",
    writeSomething: "Write something…",
  },

  badge: {
    onBoards: (n) => `On ${s(n, "canvas", "canvases")}`,
    notPlaced: "Not on a canvas",
    links: (n) => links(n),
    noLinks: "No links",
    summary: (parts) => parts.join(" · "),
    viewInTitle: (summary, board) => `${summary} · Click to view on canvas “${board}”`,
    viewInLabel: (summary) => `${summary}, view on canvas`,
    pickLabel: (summary) => `${summary}, choose a canvas`,
    viewHeading: "View on canvas (recently modified first)",
    notPlacedHeading: (n) => `${n === 1 ? "Has 1 link" : `Has ${n} links`}, but this annotation isn't on a canvas yet. Place it on:`,
    createAndPlace: "New canvas and place it there",
    createFailed: "Couldn't create the canvas",
  },

  deleteImpact: (l, b) => {
    const parts = [l ? links(l) : "", b ? `its ${b === 1 ? "card on 1 canvas" : `cards on ${b} canvases`}` : ""].filter(Boolean);
    if (!parts.length) return "No links, and not on any canvas.";
    return `This also deletes ${parts.join(" and ")}${l ? " (links disappear from all canvases and from “Related notes”)" : ""}.`;
  },

  export: {
    missing: (what) => `(${what})`,
    source: (paper, page) => `— *${paper}*, p. ${page}`,
    aliases: (list) => `Aliases: ${list}`,
  },
};

export default canvas;

// reader 模块的界面文案（英文）。结构必须与 zh/reader.ts 一致，由类型检查保证。
import type { Messages } from "../zh";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const reader: Messages["reader"] = {
  area: {
    empty: "Select a paper on the left",
    paneEmptyFocused: "Click a paper on the left to open it in this pane",
    paneEmptyUnfocused: "Click here, then choose a paper on the left to open it in this pane",
    resizePanes: "Drag to resize panes",
  },
  tabs: {
    deleted: "(Deleted)",
    closeTab: "Close tab",
    closeTitle: "Close (or middle-click the tab)",
    openInOtherPane: "Open in other pane",
    closeOthers: "Close other tabs",
    split: "Split view",
    unsplit: "Exit split view",
  },
  toolbar: {
    zoomOut: "Zoom out (Ctrl/⌘ -)",
    zoomIn: "Zoom in (Ctrl/⌘ +)",
    zoomLevel: "Zoom level",
    fitWidth: "Fit width",
    pageNumber: "Page number",
  },
  viewer: {
    opening: "Opening…",
    paperMissing: "This paper doesn't exist or has been deleted",
    cannotOpen: (reason) => `Couldn't open: ${reason}`,
    pdfMissing: "The PDF file is missing. Please import it again.",
    pdfChanging: "The paper's PDF kept changing while its text was being extracted",
    pageRenderFailed: "This page couldn't be rendered",
    noTextBadge: "No text",
    noTextTitle: "This page has no text layer, so text can't be selected",
    scannedBadge: "Scanned",
    scannedTitle: "Scanned page: annotation accuracy depends on OCR",
  },
  colors: {
    yellow: "Yellow",
    green: "Green",
    blue: "Blue",
    pink: "Pink",
    purple: "Purple",
  },
  page: (n) => `p. ${n}`,
  selection: {
    toolbar: "Selection toolbar",
    highlight: (color) => `${color} highlight`,
    writeNote: "Add note",
    makeTerm: "Make term",
    saveFailed: "Couldn't save highlight",
  },
  readAloud: {
    button: "Read aloud",
    buttonTitle: "Read the selected text aloud (browser's built-in voices)",
    barLabel: "Read aloud",
    reading: "Reading",
    paused: "Paused",
    pause: "Pause",
    resume: "Resume",
    stop: "Stop reading",
    rateTitle: "Speed (click to change)",
    rateLabel: (rate) => `Speed ${rate}×, click to change`,
  },
  card: {
    changeColor: "Change color",
    colorTitle: (color) => `Color: ${color}. Click to change`,
    changeColorFailed: "Couldn't change color",
    relocated: "Re-anchored",
    relocatedTitle: "Located again by its text after the PDF was replaced",
    editNote: "Edit note",
    deleteAnnotation: "Delete annotation",
    addNote: "Add a note…",
    notePlaceholder: "Write a note (Markdown and $math$ supported)",
    noteHint: "⌘Enter to save · Esc to cancel",
    saveNoteFailed: "Couldn't save note",
    openTerm: "Open term",
    selectAnnotation: "Select annotation",
    onCanvasTitle: (quote) => `${quote} (on a canvas or linked; click to view)`,
  },
  toast: {
    deleted: "Annotation deleted",
    deleteFailed: "Couldn't delete annotation",
    undoFailed: "Couldn't undo",
    dismiss: "Dismiss",
  },
  list: {
    heading: "Annotations",
    count: (n) => plural(n, "annotation", "annotations"),
    filterByField: "Filter by field",
    allFields: "All fields",
    filterByColor: "Filter by color",
    search: "Search quotes or notes",
    clearFilters: "Clear filters",
    noMatches: "No matching annotations",
    empty: "No annotations yet. Select text in a paper to highlight it or add a note.",
    orphaned: "Unanchored",
    orphanedHint: "Their text wasn't found after the PDF was replaced. Delete them, or highlight the passage again and delete the old ones.",
    noNote: "No note",
  },
  search: {
    group: "Annotations",
  },
  replace: {
    title: "Replace PDF file",
    intro:
      "Replace this paper's PDF with a new file (e.g. a newer arXiv version). Annotations are re-anchored by their text; those whose text can't be found are marked “Unanchored” and can be reviewed in the annotation list.",
    busy: "Replacing and re-anchoring annotations…",
    choose: "Click to choose a new PDF file",
    viewOrphaned: "View unanchored annotations",
    done: "Done",
    unchanged: "The selected file is identical to the current PDF. Nothing to replace.",
    conflict: (title) => `This file is already used by another paper, “${title}”, so it can't be used here.`,
    failed: (reason) => `Replacement failed: ${reason}`,
    replacedReanchorFailed: (pages) =>
      `Replaced with the new file (${plural(pages, "page", "pages")}). Annotations couldn't be re-anchored yet; this will be retried the next time you open the paper.`,
    replacedNothing: (pages) => `Replaced with the new file (${plural(pages, "page", "pages")}). This paper has no annotations to re-anchor.`,
    replacedSummary: (pages, relocated, orphaned) =>
      `Replaced with the new file (${plural(pages, "page", "pages")}). ${plural(relocated, "annotation", "annotations")} re-anchored` +
      (orphaned ? `; ${orphaned} couldn't be found in the new file and ${orphaned === 1 ? "was" : "were"} moved to “Unanchored”` : "") +
      ".",
    errors: {
      unreadable: "Couldn't read the file",
      notPdf: "Not a PDF file",
      paperMissing: "Paper not found",
      encrypted: "Encrypted PDFs aren't supported yet",
      corrupt: "The file is damaged or isn't a valid PDF",
      noPages: "The PDF has no pages",
    },
  },
};

export default reader;

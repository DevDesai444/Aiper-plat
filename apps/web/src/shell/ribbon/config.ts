import type { LucideIcon } from 'lucide-react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  BarChart3,
  Blocks,
  Book,
  BookMarked,
  BookOpen,
  BookOpenCheck,
  CaseSensitive,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Combine,
  Compass,
  Copy,
  DollarSign,
  Eraser,
  Eye,
  FileBarChart,
  FileOutput,
  FilePlus,
  FileText,
  FolderSearch,
  Footprints,
  GitCompare,
  Grid3x3,
  Hash,
  Image,
  IndentDecrease,
  IndentIncrease,
  Languages,
  LayoutGrid,
  Library,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  MessageSquare,
  MessageSquarePlus,
  MessageSquareX,
  MoveVertical,
  PanelTop,
  PenLine,
  Quote,
  RectangleHorizontal,
  RotateCw,
  Rows,
  ScrollText,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Shapes,
  Sigma,
  SpellCheck,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Subscript,
  Superscript,
  Table,
  Type,
  Users2,
  Volume2,
  ZoomIn,
  Paintbrush,
  Sparkles,
  Sparkle,
} from 'lucide-react'
import type { RibbonTabId } from '../uiStore'

export interface RibbonBigButton {
  id: string
  label: string
  icon: LucideIcon
  act: string
}

export interface RibbonSmallButton {
  id: string
  label?: string
  icon?: LucideIcon
  glyph?: string
  glyphStyle?: 'bold' | 'italic' | 'underline' | 'strike'
  width?: number
  act: string
}

export interface RibbonGroup {
  name: string
  big?: RibbonBigButton[]
  rows?: RibbonSmallButton[][]
}

/**
 * Trimmed ribbon config for v2. Kept per blueprint: Home, Insert, Layout,
 * References, Review, View. Dropped: File (its actions live in shell chrome),
 * Design (theme cycling makes no sense outside the pharma-CTD styling), and
 * Mailings (mail-merge is a Word-era feature the satellite domain does not
 * need). Compliance renamed to Compatibility — its groups now describe
 * component / product-tree compatibility rather than pharma compliance;
 * E9 fills the semantics when the compat dashboard lands.
 *
 * Every button's `act` is a plain string. `runRibbonAction` in actions.ts
 * is a stub for PR-1b — E7 wires editor commands, E9 wires domain-page
 * commands.
 */
export const RIBBON: Record<RibbonTabId, RibbonGroup[]> = {
  Home: [
    {
      name: 'CLIPBOARD',
      big: [{ id: 'paste', label: 'Paste', icon: Copy, act: 'edit.paste' }],
      rows: [
        [
          { id: 'cut', label: 'Cut', icon: Scissors, act: 'edit.cut' },
          { id: 'copy', label: 'Copy', icon: Copy, act: 'edit.copy' },
          { id: 'formatPainter', label: 'Format painter', icon: Paintbrush, act: 'edit.formatPainter' },
        ],
      ],
    },
    {
      name: 'FONT',
      rows: [
        [
          { id: 'fontFamily', label: 'Times New Roman', width: 132, act: 'font.family' },
          { id: 'fontSize', label: '11', width: 34, act: 'font.size' },
          { id: 'fontGrow', glyph: 'A+', act: 'font.grow' },
          { id: 'fontShrink', glyph: 'A-', act: 'font.shrink' },
        ],
        [
          { id: 'bold', glyph: 'B', glyphStyle: 'bold', act: 'mark.bold' },
          { id: 'italic', glyph: 'I', glyphStyle: 'italic', act: 'mark.italic' },
          { id: 'underline', glyph: 'U', glyphStyle: 'underline', act: 'mark.underline' },
          { id: 'strike', glyph: 'S', glyphStyle: 'strike', act: 'mark.strike' },
          { id: 'subscript', icon: Subscript, act: 'mark.subscript' },
          { id: 'superscript', icon: Superscript, act: 'mark.superscript' },
          { id: 'changeCase', icon: CaseSensitive, act: 'font.changeCase' },
          { id: 'clearFormat', icon: Eraser, act: 'mark.clearFormatting' },
        ],
      ],
    },
    {
      name: 'PARAGRAPH',
      rows: [
        [
          { id: 'bulletList', icon: List, act: 'list.bullet' },
          { id: 'numberedList', icon: ListOrdered, act: 'list.ordered' },
          { id: 'toc', icon: ListTree, act: 'insert.toc' },
          { id: 'indentLeft', icon: IndentDecrease, act: 'paragraph.outdent' },
          { id: 'indentRight', icon: IndentIncrease, act: 'paragraph.indent' },
          { id: 'shapes', icon: Shapes, act: 'insert.shapes' },
          { id: 'symbol', icon: Sigma, act: 'insert.symbol' },
        ],
        [
          { id: 'alignLeft', icon: AlignLeft, act: 'align.left' },
          { id: 'alignCenter', icon: AlignCenter, act: 'align.center' },
          { id: 'alignRight', icon: AlignRight, act: 'align.right' },
          { id: 'alignJustify', icon: AlignJustify, act: 'align.justify' },
          { id: 'lineSpacing', icon: MoveVertical, act: 'paragraph.lineSpacing' },
          { id: 'table', icon: Table, act: 'insert.table' },
        ],
      ],
    },
    {
      name: 'STYLES',
      big: [{ id: 'styles', label: 'Styles', icon: LayoutGrid, act: 'styles.gallery' }],
      rows: [
        [
          { id: 'h1', label: 'Heading 1', act: 'style.heading1' },
          { id: 'h2', label: 'Heading 2', act: 'style.heading2' },
        ],
        [
          { id: 'normal', label: 'Normal', act: 'style.normal' },
          { id: 'reference', label: 'Reference', act: 'style.reference' },
        ],
      ],
    },
    {
      name: 'EDITING',
      rows: [
        [
          { id: 'find', label: 'Find', icon: PenLine, act: 'edit.find' },
          { id: 'replace', label: 'Replace', icon: PenLine, act: 'edit.replace' },
          { id: 'select', label: 'Select', icon: Blocks, act: 'edit.select' },
        ],
      ],
    },
    {
      name: 'ASSIST',
      big: [
        { id: 'editor', label: 'Editor', icon: Sparkles, act: 'assist.editor' },
        { id: 'checkDoc', label: 'Check doc', icon: ShieldCheck, act: 'compat.checkDocument' },
      ],
    },
  ],
  Insert: [
    {
      name: 'PAGES',
      rows: [
        [
          { id: 'coverPage', label: 'Cover page', icon: FileText, act: 'insert.coverPage' },
          { id: 'blankPage', label: 'Blank page', icon: FilePlus, act: 'insert.blankPage' },
          { id: 'pageBreak', label: 'Page break', icon: SplitSquareHorizontal, act: 'insert.pageBreak' },
        ],
      ],
    },
    { name: 'TABLES', rows: [[{ id: 'table', label: 'Table', icon: Table, act: 'insert.table' }]] },
    {
      name: 'ILLUSTRATIONS',
      rows: [
        [
          { id: 'pictures', label: 'Pictures', icon: Image, act: 'insert.image' },
          { id: 'shapes', label: 'Shapes', icon: Shapes, act: 'insert.shapes' },
          { id: 'chart', label: 'Chart', icon: BarChart3, act: 'insert.chart' },
        ],
      ],
    },
    {
      name: 'LINKS',
      rows: [
        [
          { id: 'link', label: 'Link', icon: Link2, act: 'insert.link' },
          { id: 'crossRef', label: 'Cross-reference', icon: Quote, act: 'insert.crossReference' },
        ],
      ],
    },
    { name: 'COMMENTS', rows: [[{ id: 'comment', label: 'Comment', icon: MessageSquare, act: 'insert.comment' }]] },
    {
      name: 'HEADER & FOOTER',
      rows: [
        [
          { id: 'header', label: 'Header', icon: PanelTop, act: 'insert.header' },
          { id: 'pageNumber', label: 'Page number', icon: Hash, act: 'insert.pageNumber' },
        ],
      ],
    },
    { name: 'SYMBOLS', rows: [[{ id: 'equation', label: 'Equation', icon: Sigma, act: 'insert.equation' }]] },
  ],
  Layout: [
    {
      name: 'PAGE SETUP',
      big: [
        { id: 'margins', label: 'Margins', icon: RectangleHorizontal, act: 'layout.margins' },
        { id: 'orientation', label: 'Orientation', icon: RotateCw, act: 'layout.orientation' },
        { id: 'size', label: 'Size A4', icon: FileText, act: 'layout.sizeA4' },
      ],
      rows: [
        [
          { id: 'columns', label: 'Columns', icon: Rows, act: 'layout.columns' },
          { id: 'breaks', label: 'Breaks', icon: SplitSquareHorizontal, act: 'layout.breaks' },
          { id: 'lineNumbers', label: 'Line numbers', icon: Hash, act: 'layout.lineNumbers' },
        ],
      ],
    },
  ],
  References: [
    {
      name: 'TABLE OF CONTENTS',
      rows: [
        [
          { id: 'tocInsert', label: 'Add text', icon: ListChecks, act: 'toc.addText' },
          { id: 'tocUpdate', label: 'Update table', icon: ListTree, act: 'toc.update' },
        ],
      ],
    },
    {
      name: 'FOOTNOTES',
      rows: [
        [
          { id: 'footnote', label: 'Insert footnote', icon: Footprints, act: 'footnote.insert' },
          { id: 'nextFootnote', label: 'Next footnote', icon: ChevronRight, act: 'footnote.next' },
        ],
      ],
    },
    {
      name: 'CITATIONS',
      rows: [
        [
          { id: 'citation', label: 'Insert citation', icon: BookMarked, act: 'citation.insert' },
          { id: 'manageSources', label: 'Manage sources', icon: Library, act: 'citation.manageSources' },
        ],
        [
          { id: 'citeStyle', label: 'Style: ECSS', icon: Book, act: 'citation.style' },
          { id: 'bibliography', label: 'Bibliography', icon: ScrollText, act: 'citation.bibliography' },
        ],
      ],
    },
    {
      name: 'CAPTIONS',
      rows: [
        [
          { id: 'caption', label: 'Insert caption', icon: Quote, act: 'caption.insert' },
          { id: 'figureTable', label: 'Table of figures', icon: Grid3x3, act: 'caption.figureTable' },
        ],
      ],
    },
  ],
  Review: [
    {
      name: 'PROOFING',
      rows: [
        [
          { id: 'spelling', label: 'Spelling', icon: SpellCheck, act: 'review.spelling' },
          { id: 'thesaurus', label: 'Thesaurus', icon: Book, act: 'review.thesaurus' },
          { id: 'wordCount', label: 'Word count', icon: Type, act: 'review.wordCount' },
          { id: 'readAloud', label: 'Read aloud', icon: Volume2, act: 'review.readAloud' },
        ],
      ],
    },
    {
      name: 'LANGUAGE',
      rows: [
        [
          { id: 'translate', label: 'Translate', icon: Languages, act: 'review.translate' },
          { id: 'language', label: 'Language EN-US', icon: Languages, act: 'review.language' },
        ],
      ],
    },
    {
      name: 'COMMENTS',
      rows: [
        [
          { id: 'newComment', label: 'New comment', icon: MessageSquarePlus, act: 'comment.new' },
          { id: 'deleteComment', label: 'Delete comment', icon: MessageSquareX, act: 'comment.delete' },
        ],
        [
          { id: 'prevComment', label: 'Previous', icon: ChevronLeft, act: 'comment.prev' },
          { id: 'nextComment', label: 'Next', icon: ChevronRight, act: 'comment.next' },
        ],
      ],
    },
    {
      name: 'TRACKING',
      rows: [
        [
          { id: 'trackChanges', label: 'Track changes', icon: PenLine, act: 'track.toggle' },
          { id: 'allMarkup', label: 'All markup', act: 'track.allMarkup' },
        ],
        [
          { id: 'showMarkup', label: 'Show markup', icon: Eye, act: 'track.showMarkup' },
          { id: 'reviewingPane', label: 'Reviewing pane', icon: PanelTop, act: 'track.reviewingPane' },
        ],
      ],
    },
    {
      name: 'CHANGES',
      rows: [
        [
          { id: 'accept', label: 'Accept', icon: CheckCheck, act: 'track.accept' },
          { id: 'reject', label: 'Reject', icon: MessageSquareX, act: 'track.reject' },
        ],
      ],
    },
    {
      name: 'COMPARE',
      rows: [
        [
          { id: 'compare', label: 'Compare', icon: GitCompare, act: 'review.compare' },
          { id: 'combine', label: 'Combine', icon: Combine, act: 'review.combine' },
        ],
      ],
    },
    {
      name: 'PROTECT',
      rows: [
        [
          { id: 'restrictEditing', label: 'Restrict editing', icon: ShieldAlert, act: 'review.restrictEditing' },
          { id: 'blockAuthors', label: 'Block authors', icon: Users2, act: 'review.blockAuthors' },
        ],
      ],
    },
  ],
  View: [
    {
      name: 'VIEWS',
      rows: [
        [
          { id: 'printLayout', label: 'Print layout', icon: FileText, act: 'view.printLayout' },
          { id: 'readMode', label: 'Read mode', icon: BookOpenCheck, act: 'view.readMode' },
        ],
        [
          { id: 'outline', label: 'Outline', icon: ListTree, act: 'view.outline' },
          { id: 'draft', label: 'Draft', icon: ScrollText, act: 'view.draft' },
        ],
      ],
    },
    {
      name: 'SHOW',
      rows: [
        [
          { id: 'ruler', label: 'Ruler', icon: Compass, act: 'view.ruler' },
          { id: 'gridlines', label: 'Gridlines', icon: Grid3x3, act: 'view.gridlines' },
          { id: 'navPane', label: 'Navigation pane', icon: PanelTop, act: 'view.navigationPane' },
        ],
      ],
    },
    {
      name: 'ZOOM',
      rows: [
        [
          { id: 'zoom', label: 'Zoom', icon: ZoomIn, act: 'view.zoom' },
          { id: 'onePage', label: 'One page', act: 'view.onePage' },
          { id: 'pageWidth', label: 'Page width', act: 'view.pageWidth' },
        ],
      ],
    },
    {
      name: 'WINDOW',
      rows: [
        [
          { id: 'split', label: 'Split', icon: SplitSquareVertical, act: 'view.split' },
          { id: 'sideBySide', label: 'Side by side', icon: SplitSquareHorizontal, act: 'view.sideBySide' },
        ],
      ],
    },
  ],
  Compatibility: [
    {
      name: 'THIS DOCUMENT',
      big: [{ id: 'checkNow', label: 'Check now', icon: ShieldCheck, act: 'compat.checkDocument' }],
      rows: [
        [{ id: 'showMarkers', label: 'Show markers', icon: Eye, act: 'compat.showMarkers' }],
        [{ id: 'findingReport', label: 'Finding report', icon: FileBarChart, act: 'compat.findingReport' }],
        [{ id: 'resolveAll', label: 'Resolve all', icon: CheckCheck, act: 'compat.resolveAll' }],
      ],
    },
    {
      name: 'PROJECT',
      big: [{ id: 'checkProject', label: 'Check project', icon: FolderSearch, act: 'compat.checkProject' }],
      rows: [
        [{ id: 'crossDoc', label: 'Cross-doc consistency', icon: GitCompare, act: 'compat.crossDoc' }],
        [{ id: 'estimateCost', label: 'Estimate cost', icon: DollarSign, act: 'compat.estimateCost' }],
        [{ id: 'exportReport', label: 'Export report', icon: FileOutput, act: 'compat.exportReport' }],
      ],
    },
    {
      name: 'KNOWLEDGE',
      big: [{ id: 'rulebook', label: 'Rulebook', icon: BookOpen, act: 'workspace.rulebook' }],
      rows: [
        [{ id: 'precedentSearch', label: 'Precedent search', icon: FolderSearch, act: 'ai.precedentSearch' }],
      ],
    },
    {
      name: 'RESEARCH',
      big: [{ id: 'aiCompanion', label: 'AI companion', icon: Sparkles, act: 'ai.open' }],
      rows: [
        [{ id: 'askSelection', label: 'Ask about selection', icon: Sparkle, act: 'ai.askSelection' }],
        [{ id: 'citeGuidance', label: 'Cite guidance', icon: Quote, act: 'ai.citeGuidance' }],
      ],
    },
  ],
}

export const RIBBON_TAB_ORDER: RibbonTabId[] = [
  'Home',
  'Insert',
  'Layout',
  'References',
  'Review',
  'View',
  'Compatibility',
]

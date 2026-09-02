import type { LucideIcon } from 'lucide-react'
import {
  Save,
  Printer,
  FolderOpen,
  FileUp,
  FileOutput,
  Share2,
  Lock,
  BookOpen,
  History,
  Settings as SettingsIcon,
  FilePlus,
  Scissors,
  Copy,
  Paintbrush,
  Eraser,
  CaseSensitive,
  Subscript,
  Superscript,
  List,
  ListOrdered,
  ListTree,
  IndentIncrease,
  IndentDecrease,
  Shapes,
  Sigma,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  MoveVertical,
  Table,
  LayoutGrid,
  Mic,
  Sparkles,
  ShieldCheck,
  FileText,
  Image,
  BarChart3,
  Presentation,
  Camera,
  Box,
  ImagePlus,
  Link2,
  Bookmark,
  Quote,
  MessageSquare,
  PanelTop,
  PanelBottom,
  Hash,
  Type,
  Sparkle,
  Droplet,
  PenLine,
  Signature,
  Clock,
  Package,
  Palette,
  SwatchBook,
  Paintbrush2,
  Droplets,
  Waves,
  RectangleHorizontal,
  Rows3,
  SplitSquareHorizontal,
  Move,
  WrapText,
  AlignHorizontalJustifyCenter,
  BringToFront,
  SendToBack,
  Users,
  RotateCw,
  Palette as PaletteIcon,
  ListChecks,
  Footprints,
  BookMarked,
  Library,
  ListOrdered as IndexIcon,
  SpellCheck,
  Book,
  Volume2,
  Languages,
  MessageSquarePlus,
  MessageSquareX,
  ChevronLeft,
  ChevronRight,
  GitCompare,
  Combine,
  ShieldAlert,
  Users2,
  BookOpenCheck,
  ScrollText,
  Rows,
  Grid3x3,
  Compass,
  ZoomIn,
  AppWindow,
  SplitSquareVertical,
  Blocks,
  Send,
  Tags,
  UserPlus,
  ListPlus,
  MailPlus,
  CheckCheck,
  Eye,
  FolderSearch,
  DollarSign,
  FileBarChart,
  Undo2,
  Redo2
} from 'lucide-react'
import type { RibbonTabId } from '../store/uiStore'

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

export const RIBBON: Record<RibbonTabId, RibbonGroup[]> = {
  File: [
    {
      name: 'DOCUMENT',
      big: [
        { id: 'save', label: 'Save', icon: Save, act: 'file.save' },
        { id: 'print', label: 'Print', icon: Printer, act: 'file.print' }
      ],
      rows: [
        [
          { id: 'new', label: 'New', icon: FilePlus, act: 'file.new' },
          { id: 'open', label: 'Open', icon: FolderOpen, act: 'file.open' }
        ],
        [
          { id: 'exportPdf', label: 'Export PDF', icon: FileOutput, act: 'file.exportPdf' },
          { id: 'share', label: 'Share', icon: Share2, act: 'file.share' }
        ],
        [{ id: 'protect', label: 'Protect document', icon: Lock, act: 'file.protect' }]
      ]
    },
    {
      name: 'WORKSPACE',
      big: [{ id: 'openFolder', label: 'Open project', icon: FolderOpen, act: 'folder.open' }],
      rows: [
        [{ id: 'uploadDocument', label: 'Add file to project', icon: FileUp, act: 'project.uploadDocument' }],
        [{ id: 'rulebook', label: 'Rulebook v4.2', icon: BookOpen, act: 'workspace.rulebook' }],
        [{ id: 'history', label: 'Version history', icon: History, act: 'workspace.history' }],
        [{ id: 'people', label: 'People', icon: Users, act: 'app.people' }],
        [{ id: 'settings', label: 'Settings', icon: SettingsIcon, act: 'app.settings' }]
      ]
    }
  ],
  Home: [
    {
      name: 'CLIPBOARD',
      big: [{ id: 'paste', label: 'Paste', icon: Copy, act: 'edit.paste' }],
      rows: [
        [
          { id: 'cut', label: 'Cut', icon: Scissors, act: 'edit.cut' },
          { id: 'copy', label: 'Copy', icon: Copy, act: 'edit.copy' },
          { id: 'formatPainter', label: 'Format painter', icon: Paintbrush, act: 'edit.formatPainter' }
        ]
      ]
    },
    {
      name: 'FONT',
      rows: [
        [
          { id: 'fontFamily', label: 'Times New Roman', width: 132, act: 'font.family' },
          { id: 'fontSize', label: '11', width: 34, act: 'font.size' },
          { id: 'fontGrow', glyph: 'A+', act: 'font.grow' },
          { id: 'fontShrink', glyph: 'A-', act: 'font.shrink' }
        ],
        [
          { id: 'bold', glyph: 'B', glyphStyle: 'bold', act: 'mark.bold' },
          { id: 'italic', glyph: 'I', glyphStyle: 'italic', act: 'mark.italic' },
          { id: 'underline', glyph: 'U', glyphStyle: 'underline', act: 'mark.underline' },
          { id: 'strike', glyph: 'S', glyphStyle: 'strike', act: 'mark.strike' },
          { id: 'subscript', icon: Subscript, act: 'mark.subscript' },
          { id: 'superscript', icon: Superscript, act: 'mark.superscript' },
          { id: 'changeCase', icon: CaseSensitive, act: 'font.changeCase' },
          { id: 'clearFormat', icon: Eraser, act: 'mark.clearFormatting' }
        ]
      ]
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
          { id: 'symbol', icon: Sigma, act: 'insert.symbol' }
        ],
        [
          { id: 'alignLeft', icon: AlignLeft, act: 'align.left' },
          { id: 'alignCenter', icon: AlignCenter, act: 'align.center' },
          { id: 'alignRight', icon: AlignRight, act: 'align.right' },
          { id: 'alignJustify', icon: AlignJustify, act: 'align.justify' },
          { id: 'lineSpacing', icon: MoveVertical, act: 'paragraph.lineSpacing' },
          { id: 'shapes2', icon: Shapes, act: 'insert.shapes' },
          { id: 'table', icon: Table, act: 'insert.table' }
        ]
      ]
    },
    {
      name: 'STYLES',
      big: [{ id: 'styles', label: 'Styles', icon: LayoutGrid, act: 'styles.gallery' }],
      rows: [
        [
          { id: 'h1', label: 'Heading 1', act: 'style.heading1' },
          { id: 'h2', label: 'Heading 2', act: 'style.heading2' }
        ],
        [
          { id: 'normal', label: 'Normal', act: 'style.normal' },
          { id: 'tableCaption', label: 'Table caption', act: 'style.tableCaption' }
        ],
        [
          { id: 'ctdSection', label: 'CTD section', act: 'style.ctdSection' },
          { id: 'reference', label: 'Reference', act: 'style.reference' }
        ]
      ]
    },
    {
      name: 'EDITING',
      rows: [
        [
          { id: 'find', label: 'Find', icon: PenLine, act: 'edit.find' },
          { id: 'replace', label: 'Replace', icon: PenLine, act: 'edit.replace' },
          { id: 'select', label: 'Select', icon: Blocks, act: 'edit.select' }
        ]
      ]
    },
    {
      name: 'VOICE',
      big: [{ id: 'dictate', label: 'Dictate', icon: Mic, act: 'voice.dictate' }]
    },
    {
      name: 'ASSIST',
      big: [
        { id: 'editor', label: 'Editor', icon: Sparkles, act: 'assist.editor' },
        { id: 'checkDoc', label: 'Check doc', icon: ShieldCheck, act: 'compliance.checkDocument' }
      ]
    }
  ],
  Insert: [
    {
      name: 'PAGES',
      rows: [
        [
          { id: 'coverPage', label: 'Cover page', icon: FileText, act: 'insert.coverPage' },
          { id: 'blankPage', label: 'Blank page', icon: FilePlus, act: 'insert.blankPage' },
          { id: 'pageBreak', label: 'Page break', icon: SplitSquareHorizontal, act: 'insert.pageBreak' }
        ]
      ]
    },
    { name: 'TABLES', rows: [[{ id: 'table', label: 'Table', icon: Table, act: 'insert.table' }]] },
    {
      name: 'ILLUSTRATIONS',
      rows: [
        [
          { id: 'pictures', label: 'Pictures', icon: Image, act: 'insert.image' },
          { id: 'shapes', label: 'Shapes', icon: Shapes, act: 'insert.shapes' },
          { id: 'icons', label: 'Icons', icon: ImagePlus, act: 'insert.icons' },
          { id: 'chart', label: 'Chart', icon: BarChart3, act: 'insert.chart' }
        ],
        [
          { id: 'smartArt', label: 'SmartArt', icon: Presentation, act: 'insert.smartArt' },
          { id: 'screenshot', label: 'Screenshot', icon: Camera, act: 'insert.screenshot' },
          { id: 'model3d', label: '3D model', icon: Box, act: 'insert.model3d' }
        ]
      ]
    },
    {
      name: 'LINKS',
      rows: [
        [
          { id: 'link', label: 'Link', icon: Link2, act: 'insert.link' },
          { id: 'bookmark', label: 'Bookmark', icon: Bookmark, act: 'insert.bookmark' },
          { id: 'crossRef', label: 'Cross-reference', icon: Quote, act: 'insert.crossReference' }
        ]
      ]
    },
    { name: 'COMMENTS', rows: [[{ id: 'comment', label: 'Comment', icon: MessageSquare, act: 'insert.comment' }]] },
    {
      name: 'HEADER & FOOTER',
      rows: [
        [
          { id: 'header', label: 'Header', icon: PanelTop, act: 'insert.header' },
          { id: 'footer', label: 'Footer', icon: PanelBottom, act: 'insert.footer' },
          { id: 'pageNumber', label: 'Page number', icon: Hash, act: 'insert.pageNumber' }
        ]
      ]
    },
    {
      name: 'TEXT',
      rows: [
        [
          { id: 'textBox', label: 'Text box', icon: Type, act: 'insert.textBox' },
          { id: 'quickParts', label: 'Quick parts', icon: Sparkle, act: 'insert.quickParts' },
          { id: 'wordArt', label: 'WordArt', icon: Droplet, act: 'insert.wordArt' }
        ],
        [
          { id: 'dropCap', label: 'Drop cap', icon: PenLine, act: 'insert.dropCap' },
          { id: 'signature', label: 'Signature line', icon: Signature, act: 'insert.signature' },
          { id: 'dateTime', label: 'Date & time', icon: Clock, act: 'insert.dateTime' },
          { id: 'object', label: 'Object', icon: Package, act: 'insert.object' }
        ]
      ]
    },
    { name: 'SYMBOLS', rows: [[{ id: 'equation', label: 'Equation', icon: Sigma, act: 'insert.equation' }]] }
  ],
  Design: [
    {
      name: 'THEMES',
      rows: [
        [
          { id: 'themeCtd', label: 'Aiper CTD', icon: Palette, act: 'design.theme.aiperCtd' },
          { id: 'themePlain', label: 'eCTD plain', icon: SwatchBook, act: 'design.theme.ectdPlain' }
        ],
        [
          { id: 'colors', label: 'Colors', icon: Paintbrush2, act: 'design.colors' },
          { id: 'fonts', label: 'Fonts', icon: Type, act: 'design.fonts' }
        ],
        [
          { id: 'spacing', label: 'Paragraph spacing', icon: Rows3, act: 'design.spacing' },
          { id: 'effects', label: 'Effects', icon: Droplets, act: 'design.effects' }
        ]
      ]
    },
    {
      name: 'PAGE',
      rows: [
        [
          { id: 'watermark', label: 'Watermark', icon: Waves, act: 'design.watermark' },
          { id: 'pageColor', label: 'Page color', icon: PaletteIcon, act: 'design.pageColor' },
          { id: 'pageBorders', label: 'Page borders', icon: RectangleHorizontal, act: 'design.pageBorders' }
        ]
      ]
    }
  ],
  Layout: [
    {
      name: 'PAGE SETUP',
      big: [
        { id: 'margins', label: 'Margins', icon: RectangleHorizontal, act: 'layout.margins' },
        { id: 'orientation', label: 'Orientation', icon: RotateCw, act: 'layout.orientation' },
        { id: 'size', label: 'Size A4', icon: FileText, act: 'layout.sizeA4' }
      ],
      rows: [
        [
          { id: 'columns', label: 'Columns', icon: Rows, act: 'layout.columns' },
          { id: 'breaks', label: 'Breaks', icon: SplitSquareHorizontal, act: 'layout.breaks' },
          { id: 'lineNumbers', label: 'Line numbers', icon: Hash, act: 'layout.lineNumbers' }
        ],
        [
          { id: 'indentLeft', label: '0 cm', act: 'layout.indentLeft' },
          { id: 'indentRight', label: '0 cm', act: 'layout.indentRight' },
          { id: 'spacingBefore', label: '6 pt', act: 'layout.spacingBefore' }
        ]
      ]
    },
    {
      name: 'ARRANGE',
      rows: [
        [
          { id: 'position', label: 'Position', icon: Move, act: 'arrange.position' },
          { id: 'wrapText', label: 'Wrap text', icon: WrapText, act: 'arrange.wrapText' },
          { id: 'align', label: 'Align', icon: AlignHorizontalJustifyCenter, act: 'arrange.align' }
        ],
        [
          { id: 'bringForward', label: 'Bring forward', icon: BringToFront, act: 'arrange.bringForward' },
          { id: 'group', label: 'Group', icon: Users, act: 'arrange.group' },
          { id: 'sendBackward', label: 'Send backward', icon: SendToBack, act: 'arrange.sendBackward' },
          { id: 'rotate', label: 'Rotate', icon: RotateCw, act: 'arrange.rotate' }
        ]
      ]
    }
  ],
  References: [
    {
      name: 'TABLE OF CONTENTS',
      rows: [
        [
          { id: 'tocInsert', label: 'Add text', icon: ListChecks, act: 'toc.addText' },
          { id: 'tocUpdate', label: 'Update table', icon: ListTree, act: 'toc.update' }
        ]
      ]
    },
    {
      name: 'FOOTNOTES',
      rows: [
        [
          { id: 'footnote', label: 'Insert footnote', icon: Footprints, act: 'footnote.insert' },
          { id: 'nextFootnote', label: 'Next footnote', icon: ChevronRight, act: 'footnote.next' }
        ]
      ]
    },
    {
      name: 'CITATIONS & BIBLIOGRAPHY',
      rows: [
        [
          { id: 'citation', label: 'Insert citation', icon: BookMarked, act: 'citation.insert' },
          { id: 'manageSources', label: 'Manage sources', icon: Library, act: 'citation.manageSources' }
        ],
        [
          { id: 'citeStyle', label: 'Style: ICH / CTD', icon: Book, act: 'citation.style' },
          { id: 'bibliography', label: 'Bibliography', icon: ScrollText, act: 'citation.bibliography' }
        ]
      ]
    },
    {
      name: 'CAPTIONS',
      rows: [
        [
          { id: 'caption', label: 'Insert caption', icon: Quote, act: 'caption.insert' },
          { id: 'figureTable', label: 'Table of figures', icon: Grid3x3, act: 'caption.figureTable' },
          { id: 'crossRef', label: 'Cross-reference', icon: Compass, act: 'insert.crossReference' }
        ]
      ]
    },
    {
      name: 'INDEX',
      rows: [
        [
          { id: 'markEntry', label: 'Mark entry', icon: IndexIcon, act: 'index.markEntry' },
          { id: 'insertIndex', label: 'Insert index', icon: IndexIcon, act: 'index.insert' },
          { id: 'updateIndex', label: 'Update index', icon: IndexIcon, act: 'index.update' }
        ]
      ]
    }
  ],
  Mailings: [
    {
      name: 'CREATE',
      rows: [
        [
          { id: 'envelopes', label: 'Envelopes', icon: MailPlus, act: 'mailings.envelopes' },
          { id: 'labels', label: 'Labels', icon: Tags, act: 'mailings.labels' }
        ]
      ]
    },
    {
      name: 'START MAIL MERGE',
      rows: [
        [
          { id: 'startMerge', label: 'Start merge', icon: ListPlus, act: 'mailings.startMerge' },
          { id: 'selectRecipients', label: 'Select recipients', icon: UserPlus, act: 'mailings.selectRecipients' },
          { id: 'editList', label: 'Edit list', icon: ListChecks, act: 'mailings.editList' }
        ]
      ]
    },
    {
      name: 'WRITE & INSERT FIELDS',
      rows: [
        [
          { id: 'addressBlock', label: 'Address block', icon: RectangleHorizontal, act: 'mailings.addressBlock' },
          { id: 'greetingLine', label: 'Greeting line', icon: Send, act: 'mailings.greetingLine' },
          { id: 'mergeField', label: 'Insert merge field', icon: ListPlus, act: 'mailings.mergeField' }
        ]
      ]
    },
    {
      name: 'FINISH',
      rows: [
        [
          { id: 'finishMerge', label: 'Finish & merge', icon: CheckCheck, act: 'mailings.finish' },
          { id: 'previewResults', label: 'Preview results', icon: Eye, act: 'mailings.preview' }
        ]
      ]
    }
  ],
  Review: [
    {
      name: 'PROOFING',
      rows: [
        [
          { id: 'spelling', label: 'Spelling', icon: SpellCheck, act: 'review.spelling' },
          { id: 'thesaurus', label: 'Thesaurus', icon: Book, act: 'review.thesaurus' },
          { id: 'wordCount', label: 'Word count', icon: Type, act: 'review.wordCount' },
          { id: 'readAloud', label: 'Read aloud', icon: Volume2, act: 'review.readAloud' }
        ]
      ]
    },
    {
      name: 'LANGUAGE',
      rows: [
        [
          { id: 'translate', label: 'Translate', icon: Languages, act: 'review.translate' },
          { id: 'language', label: 'Language EN-US', icon: Languages, act: 'review.language' }
        ]
      ]
    },
    {
      name: 'COMMENTS',
      rows: [
        [
          { id: 'newComment', label: 'New comment', icon: MessageSquarePlus, act: 'comment.new' },
          { id: 'deleteComment', label: 'Delete comment', icon: MessageSquareX, act: 'comment.delete' }
        ],
        [
          { id: 'prevComment', label: 'Previous', icon: ChevronLeft, act: 'comment.prev' },
          { id: 'nextComment', label: 'Next', icon: ChevronRight, act: 'comment.next' }
        ]
      ]
    },
    {
      name: 'TRACKING',
      rows: [
        [
          { id: 'trackChanges', label: 'Track changes', icon: PenLine, act: 'track.toggle' },
          { id: 'allMarkup', label: 'All markup', act: 'track.allMarkup' }
        ],
        [
          { id: 'showMarkup', label: 'Show markup', icon: Eye, act: 'track.showMarkup' },
          { id: 'reviewingPane', label: 'Reviewing pane', icon: PanelTop, act: 'track.reviewingPane' }
        ]
      ]
    },
    {
      name: 'CHANGES',
      rows: [
        [
          { id: 'accept', label: 'Accept', icon: CheckCheck, act: 'track.accept' },
          { id: 'reject', label: 'Reject', icon: MessageSquareX, act: 'track.reject' }
        ],
        [
          { id: 'prevChange', label: 'Previous', icon: ChevronLeft, act: 'track.prev' },
          { id: 'nextChange', label: 'Next', icon: ChevronRight, act: 'track.next' }
        ]
      ]
    },
    {
      name: 'COMPARE',
      rows: [
        [
          { id: 'compare', label: 'Compare', icon: GitCompare, act: 'review.compare' },
          { id: 'combine', label: 'Combine', icon: Combine, act: 'review.combine' }
        ]
      ]
    },
    {
      name: 'PROTECT',
      rows: [
        [
          { id: 'restrictEditing', label: 'Restrict editing', icon: ShieldAlert, act: 'review.restrictEditing' },
          { id: 'blockAuthors', label: 'Block authors', icon: Users2, act: 'review.blockAuthors' }
        ]
      ]
    }
  ],
  View: [
    {
      name: 'VIEWS',
      rows: [
        [
          { id: 'printLayout', label: 'Print layout', icon: FileText, act: 'view.printLayout' },
          { id: 'readMode', label: 'Read mode', icon: BookOpenCheck, act: 'view.readMode' },
          { id: 'webLayout', label: 'Web layout', icon: AppWindow, act: 'view.webLayout' }
        ],
        [
          { id: 'outline', label: 'Outline', icon: ListTree, act: 'view.outline' },
          { id: 'draft', label: 'Draft', icon: ScrollText, act: 'view.draft' }
        ]
      ]
    },
    {
      name: 'SHOW',
      rows: [
        [
          { id: 'ruler', label: 'Ruler', icon: Compass, act: 'view.ruler' },
          { id: 'gridlines', label: 'Gridlines', icon: Grid3x3, act: 'view.gridlines' },
          { id: 'navPane', label: 'Navigation pane', icon: PanelTop, act: 'view.navigationPane' }
        ]
      ]
    },
    {
      name: 'ZOOM',
      rows: [
        [
          { id: 'zoom', label: 'Zoom 85%', icon: ZoomIn, act: 'view.zoom' },
          { id: 'onePage', label: 'One page', act: 'view.onePage' },
          { id: 'multiPage', label: 'Multiple pages', act: 'view.multiPage' },
          { id: 'pageWidth', label: 'Page width', act: 'view.pageWidth' }
        ]
      ]
    },
    {
      name: 'WINDOW',
      rows: [
        [
          { id: 'newWindow', label: 'New window', icon: AppWindow, act: 'view.newWindow' },
          { id: 'split', label: 'Split', icon: SplitSquareVertical, act: 'view.split' },
          { id: 'sideBySide', label: 'Side by side', icon: SplitSquareHorizontal, act: 'view.sideBySide' },
          { id: 'arrangeAll', label: 'Arrange all', icon: LayoutGrid, act: 'view.arrangeAll' }
        ]
      ]
    },
    { name: 'MACROS', rows: [[{ id: 'macros', label: 'Macros', icon: Blocks, act: 'view.macros' }]] }
  ],
  Compliance: [
    {
      name: 'THIS DOCUMENT',
      big: [{ id: 'checkNow', label: 'Check now', icon: ShieldCheck, act: 'compliance.checkDocument' }],
      rows: [
        [{ id: 'showMarkers', label: 'Show markers', icon: Eye, act: 'compliance.showMarkers' }],
        [{ id: 'findingReport', label: 'Finding report', icon: FileBarChart, act: 'compliance.findingReport' }],
        [{ id: 'resolveAll', label: 'Resolve all', icon: CheckCheck, act: 'compliance.resolveAll' }]
      ]
    },
    {
      name: 'FOLDER',
      big: [{ id: 'checkFolder', label: 'Check folder', icon: FolderSearch, act: 'compliance.checkFolder' }],
      rows: [
        [{ id: 'crossDocConsistency', label: 'Cross-doc consistency', icon: GitCompare, act: 'compliance.crossDoc' }],
        [{ id: 'estimateCost', label: 'Estimate cost', icon: DollarSign, act: 'compliance.estimateCost' }],
        [{ id: 'exportReport', label: 'Export report', icon: FileOutput, act: 'compliance.exportReport' }]
      ]
    },
    {
      name: 'KNOWLEDGE',
      big: [{ id: 'rulebook', label: 'Rulebook', icon: BookOpen, act: 'workspace.rulebook' }],
      rows: [
        [{ id: 'precedentSearch', label: 'Precedent search', icon: FolderSearch, act: 'ai.precedentSearch' }],
        [{ id: 'andaIndexed', label: '41 ANDAs indexed', act: 'noop' }],
        [{ id: 'modelLocal', label: 'Model: local', act: 'noop' }]
      ]
    },
    {
      name: 'RESEARCH',
      big: [{ id: 'aiCompanion', label: 'AI companion', icon: Sparkles, act: 'ai.open' }],
      rows: [
        [{ id: 'askSelection', label: 'Ask about selection', icon: Sparkle, act: 'ai.askSelection' }],
        [{ id: 'citeGuidance', label: 'Cite guidance', icon: Quote, act: 'ai.citeGuidance' }]
      ]
    }
  ]
}

export const RIBBON_TAB_ORDER: RibbonTabId[] = [
  'File',
  'Home',
  'Insert',
  'Design',
  'Layout',
  'References',
  'Mailings',
  'Review',
  'View',
  'Compliance'
]

export { Undo2, Redo2 }

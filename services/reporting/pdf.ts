/**
 * PDF report rendering with `pdf-lib` (pure JS, works on Vercel's Node runtime).
 *
 * Layout
 * ------
 *   1. Title page: report name, date range, generated-by, filter summary.
 *   2. Summary: totals, % classified, % low-confidence, top 10 parents by spend.
 *   3. UNSPSC segment breakdown: table + horizontal bar chart.
 *   4. Parent/subsidiary hierarchy table.
 *   5. Low-confidence review appendix.
 *
 * The standard 14 PDF fonts use WinAnsi encoding, so text is sanitised before
 * drawing: characters outside that set would otherwise throw at draw time.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { roundTo } from '@/lib/normalize';
import { hierarchyRows, type ReportDataset } from '@/services/reporting/aggregate';

export const PDF_COLORS = {
  ink: rgb(0.09, 0.11, 0.15),
  muted: rgb(0.42, 0.45, 0.5),
  rule: rgb(0.85, 0.87, 0.9),
  accent: rgb(0.13, 0.36, 0.72),
  accentSoft: rgb(0.62, 0.74, 0.92),
  warn: rgb(0.72, 0.35, 0.09),
  bg: rgb(0.97, 0.98, 0.99),
} as const;

/** WinAnsi-safe transliteration. */
export function sanitizePdfText(input: unknown, fallback = ''): string {
  if (input === null || input === undefined) return fallback;
  const text = String(input);
  return text
    .replace(/\u2018|\u2019|\u201A|\u201B/g, "'")
    .replace(/\u201C|\u201D|\u201E/g, '"')
    .replace(/\u2013|\u2014|\u2212/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2022/g, '-')
    .replace(/\u00B7/g, '-')
    .replace(/\u2192/g, '->')
    .replace(/\u2265/g, '>=')
    .replace(/\u2264/g, '<=')
    // Drop anything still outside latin1 (emoji, CJK, etc.).
    .replace(/[^\u0000-\u00FF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function formatMoney(value: number, currency = 'USD'): string {
  const prefix = currency === 'USD' ? '$' : `${currency} `;
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? '-' : ''}${prefix}${formatted}`;
}

export function formatPercent(value: number): string {
  return `${roundTo(value, 1).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Layout engine
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

class PdfLayout {
  readonly doc: PDFDocument;
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  page: PDFPage;
  y: number;
  pageNumber = 1;
  private readonly footerLabel: string;

  private constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont, footerLabel: string) {
    this.doc = doc;
    this.regular = regular;
    this.bold = bold;
    this.footerLabel = footerLabel;
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  static async create(footerLabel: string): Promise<PdfLayout> {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    doc.setTitle(sanitizePdfText(footerLabel));
    doc.setProducer('UNSPSC Spend Categorizer');
    doc.setCreator('UNSPSC Spend Categorizer');
    doc.setCreationDate(new Date());
    return new PdfLayout(doc, regular, bold, footerLabel);
  }

  ensureSpace(height: number): void {
    if (this.y - height < MARGIN + 28) this.newPage();
  }

  newPage(): void {
    this.drawFooter();
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pageNumber += 1;
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private drawFooter(): void {
    const label = sanitizePdfText(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC | ${this.footerLabel}`);
    this.page.drawText(label, {
      x: MARGIN,
      y: MARGIN / 2,
      size: 7.5,
      font: this.regular,
      color: PDF_COLORS.muted,
    });
    const pageLabel = `Page ${this.pageNumber}`;
    const width = this.regular.widthOfTextAtSize(pageLabel, 7.5);
    this.page.drawText(pageLabel, {
      x: PAGE_WIDTH - MARGIN - width,
      y: MARGIN / 2,
      size: 7.5,
      font: this.regular,
      color: PDF_COLORS.muted,
    });
  }

  text(
    value: unknown,
    options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; maxWidth?: number; lineHeight?: number } = {},
  ): void {
    const size = options.size ?? 10;
    const font = options.bold ? this.bold : this.regular;
    const color = options.color ?? PDF_COLORS.ink;
    const maxWidth = options.maxWidth ?? CONTENT_WIDTH;
    const lineHeight = options.lineHeight ?? size * 1.35;
    const lines = wrapText(sanitizePdfText(value), font, size, maxWidth);

    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.page.drawText(line, { x: options.x ?? MARGIN, y: this.y - size, size, font, color });
      this.y -= lineHeight;
    }
  }

  heading(value: string, size = 15): void {
    this.ensureSpace(size * 2.4);
    this.y -= size * 0.7;
    this.text(value, { size, bold: true, color: PDF_COLORS.ink });
    this.rule();
  }

  rule(color = PDF_COLORS.rule): void {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.6,
      color,
    });
    this.y -= 8;
  }

  gap(height = 8): void {
    this.y -= height;
  }

  /** Draw a table; returns the number of rows rendered. */
  table(
    columns: Array<{ header: string; width: number; align?: 'left' | 'right' }>,
    rows: Array<Array<unknown>>,
    options: { fontSize?: number; zebra?: boolean; maxRows?: number } = {},
  ): void {
    const size = options.fontSize ?? 8.5;
    const rowHeight = size * 1.9;
    const totalWidth = columns.reduce((sum, column) => sum + column.width, 0);
    const scale = CONTENT_WIDTH / totalWidth;

    const drawHeader = () => {
      this.ensureSpace(rowHeight * 2);
      let x = MARGIN;
      for (const column of columns) {
        const width = column.width * scale;
        this.page.drawRectangle({ x, y: this.y - rowHeight + 2, width, height: rowHeight, color: PDF_COLORS.bg });
        this.page.drawText(sanitizePdfText(column.header), {
          x: x + 3,
          y: this.y - size - 2,
          size: size - 0.5,
          font: this.bold,
          color: PDF_COLORS.muted,
        });
        x += width;
      }
      this.y -= rowHeight;
      this.rule();
    };

    drawHeader();

    const limit = options.maxRows ?? rows.length;
    rows.slice(0, limit).forEach((row, rowIndex) => {
      if (this.y - rowHeight < MARGIN + 30) {
        this.newPage();
        drawHeader();
      }
      // Zebra stripe first, so the text drawn afterwards stays crisp on top.
      if (options.zebra !== false && rowIndex % 2 === 1) {
        this.page.drawRectangle({
          x: MARGIN,
          y: this.y - rowHeight + 2,
          width: CONTENT_WIDTH,
          height: rowHeight - 1,
          color: rgb(0.975, 0.982, 0.99),
          opacity: 0.85,
        });
      }
      let x = MARGIN;
      columns.forEach((column, columnIndex) => {
        const width = column.width * scale;
        const raw = row[columnIndex];
        const text = sanitizePdfText(raw === null || raw === undefined ? '' : raw);
        const clipped = clipText(text, this.regular, size, width - 6);
        const drawX =
          column.align === 'right' ? x + width - 3 - this.regular.widthOfTextAtSize(clipped, size) : x + 3;
        this.page.drawText(clipped, {
          x: Math.max(x + 1, drawX),
          y: this.y - size - 1,
          size,
          font: this.regular,
          color: PDF_COLORS.ink,
        });
        x += width;
      });
      this.y -= rowHeight;
    });

    if (rows.length > limit) {
      this.text(`... ${rows.length - limit} more rows (see the CSV export for the full list)`, {
        size: 7.5,
        color: PDF_COLORS.muted,
      });
    }
    this.gap(6);
  }

  /** Horizontal bar chart. */
  barChart(
    items: Array<{ label: string; value: number; caption?: string }>,
    options: { height?: number; barColor?: ReturnType<typeof rgb>; valueFormatter?: (value: number) => string } = {},
  ): void {
    if (!items.length) {
      this.text('No data for this chart.', { size: 9, color: PDF_COLORS.muted });
      return;
    }
    const barHeight = options.height ?? 13;
    const gap = 6;
    const labelWidth = 190;
    const valueWidth = 90;
    const trackWidth = CONTENT_WIDTH - labelWidth - valueWidth - 8;
    const max = Math.max(...items.map((item) => item.value), 1);
    const formatter = options.valueFormatter ?? ((value: number) => roundTo(value, 2).toLocaleString('en-US'));

    for (const item of items) {
      this.ensureSpace(barHeight + gap);
      const label = clipText(sanitizePdfText(item.label), this.regular, 8, labelWidth - 4);
      this.page.drawText(label, {
        x: MARGIN,
        y: this.y - barHeight + 3,
        size: 8,
        font: this.regular,
        color: PDF_COLORS.ink,
      });

      const trackX = MARGIN + labelWidth;
      this.page.drawRectangle({
        x: trackX,
        y: this.y - barHeight + 3,
        width: trackWidth,
        height: barHeight - 3,
        color: PDF_COLORS.bg,
      });
      const barWidth = Math.max(1.5, (item.value / max) * trackWidth);
      this.page.drawRectangle({
        x: trackX,
        y: this.y - barHeight + 3,
        width: barWidth,
        height: barHeight - 3,
        color: options.barColor ?? PDF_COLORS.accentSoft,
      });

      const valueText = clipText(`${formatter(item.value)}${item.caption ? ` ${item.caption}` : ''}`, this.regular, 8, valueWidth);
      this.page.drawText(valueText, {
        x: PAGE_WIDTH - MARGIN - this.regular.widthOfTextAtSize(valueText, 8),
        y: this.y - barHeight + 3,
        size: 8,
        font: this.regular,
        color: PDF_COLORS.muted,
      });

      this.y -= barHeight + gap;
    }
    this.gap(6);
  }

  /** KPI cards row. */
  kpiRow(cards: Array<{ label: string; value: string; caption?: string }>): void {
    const cardWidth = (CONTENT_WIDTH - (cards.length - 1) * 8) / Math.max(1, cards.length);
    const height = 46;
    this.ensureSpace(height + 10);
    let x = MARGIN;
    for (const card of cards) {
      this.page.drawRectangle({
        x,
        y: this.y - height,
        width: cardWidth,
        height,
        color: PDF_COLORS.bg,
        borderColor: PDF_COLORS.rule,
        borderWidth: 0.5,
      });
      this.page.drawText(clipText(sanitizePdfText(card.label), this.regular, 7.5, cardWidth - 10), {
        x: x + 6,
        y: this.y - 13,
        size: 7.5,
        font: this.regular,
        color: PDF_COLORS.muted,
      });
      this.page.drawText(clipText(sanitizePdfText(card.value), this.bold, 14, cardWidth - 10), {
        x: x + 6,
        y: this.y - 29,
        size: 14,
        font: this.bold,
        color: PDF_COLORS.ink,
      });
      if (card.caption) {
        this.page.drawText(clipText(sanitizePdfText(card.caption), this.regular, 7, cardWidth - 10), {
          x: x + 6,
          y: this.y - 40,
          size: 7,
          font: this.regular,
          color: PDF_COLORS.muted,
        });
      }
      x += cardWidth + 8;
    }
    this.y -= height + 12;
  }

  /**
   * Draw the brand mark: a rounded container with three ascending rounded bars.
   *
   * Built from SVG paths rather than rectangles. pdf-lib has no
   * rounded-rectangle primitive and PDF has no erase operation, so overlaying
   * "corner" squares cannot round anything — the geometry has to be correct from
   * the start. Geometry mirrors `public/icon.svg`.
   */
  brandMark(size = 46): void {
    const x0 = MARGIN;
    const yTop = this.y;

    // pdf-lib maps SVG path coordinates with the origin at (x, y) and y growing
    // downward, so each path is expressed once in the 0..64 source space and
    // scaled. The arc (`A`) command lets the corners be true quarter circles.
    const s = size / 64;

    const containerPath = [
      'M 15 0',
      'H 49',
      'A 15 15 0 0 1 64 15',
      'V 49',
      'A 15 15 0 0 1 49 64',
      'H 15',
      'A 15 15 0 0 1 0 49',
      'V 15',
      'A 15 15 0 0 1 15 0',
      'Z',
    ].join(' ');

    this.page.drawSvgPath(containerPath, {
      x: x0,
      y: yTop,
      scale: s,
      color: PDF_COLORS.accent,
      borderWidth: 0,
    });

    // Three ascending bars, each a stadium (fully rounded ends).
    const barPath = (bx: number, by: number, bw: number, bh: number): string => {
      const r = Math.min(bw, bh) / 2;
      return [
        `M ${bx + r} ${by}`,
        `H ${bx + bw - r}`,
        `A ${r} ${r} 0 0 1 ${bx + bw} ${by + r}`,
        `V ${by + bh - r}`,
        `A ${r} ${r} 0 0 1 ${bx + bw - r} ${by + bh}`,
        `H ${bx + r}`,
        `A ${r} ${r} 0 0 1 ${bx} ${by + bh - r}`,
        `V ${by + r}`,
        `A ${r} ${r} 0 0 1 ${bx + r} ${by}`,
        'Z',
      ].join(' ');
    };

    const bars: Array<{ x: number; y: number; w: number; h: number; color: ReturnType<typeof rgb> }> = [
      { x: 14, y: 34, w: 9, h: 17, color: rgb(1, 1, 1) },
      { x: 27.5, y: 26, w: 9, h: 25, color: rgb(1, 1, 1) },
      { x: 41, y: 16, w: 9, h: 35, color: rgb(0.749, 0.859, 0.996) },
    ];

    for (const bar of bars) {
      this.page.drawSvgPath(barPath(bar.x, bar.y, bar.w, bar.h), {
        x: x0,
        y: yTop,
        scale: s,
        color: bar.color,
        borderWidth: 0,
      });
    }

    this.y = yTop - size - 10;
  }

  finish(): void {
    this.drawFooter();
  }
}

/** Word-wrap using real font metrics. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }
    // Hard-break a word that is longer than the line.
    let buffer = '';
    for (const char of word) {
      if (font.widthOfTextAtSize(buffer + char, size) > maxWidth) {
        lines.push(buffer);
        buffer = char;
      } else {
        buffer += char;
      }
    }
    current = buffer;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/** Truncate with an ellipsis using real font metrics. */
export function clipText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (!text) return '';
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}...`, size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

// ---------------------------------------------------------------------------
// Report document
// ---------------------------------------------------------------------------

export type PdfReportOptions = {
  /** Maximum hierarchy rows to render before truncating. */
  maxHierarchyRows?: number;
  maxAppendixRows?: number;
};

export async function renderSupplierPdf(
  dataset: ReportDataset,
  options: PdfReportOptions = {},
): Promise<Uint8Array> {
  const layout = await PdfLayout.create(`${dataset.meta.name} | UNSPSC spend report`);

  // ---- title page ---------------------------------------------------------
  layout.gap(96);
  // Brand mark, drawn from primitives so reports carry the same identity as the
  // app without embedding an image. Geometry mirrors public/icon.svg.
  layout.brandMark();
  layout.gap(18);
  layout.text('UNSPSC SPEND REPORT', { size: 11, bold: true, color: PDF_COLORS.accent });
  layout.gap(4);
  layout.text(dataset.meta.name, { size: 26, bold: true, lineHeight: 32 });
  layout.gap(10);
  layout.rule(PDF_COLORS.accent);
  layout.gap(6);

  const from = dataset.meta.dateRange.from ?? 'earliest';
  const to = dataset.meta.dateRange.to ?? dataset.meta.generatedAt.slice(0, 10);
  layout.text(`Date range: ${from} to ${to}`, { size: 11, color: PDF_COLORS.muted });
  layout.text(`Generated by: ${dataset.meta.generatedBy}`, { size: 11, color: PDF_COLORS.muted });
  layout.text(`Generated at: ${dataset.meta.generatedAt}`, { size: 11, color: PDF_COLORS.muted });
  layout.text(`UNSPSC taxonomy: ${dataset.meta.taxonomyVersion}`, { size: 11, color: PDF_COLORS.muted });
  layout.text(`Rollup: ${dataset.meta.rollup}`, { size: 11, color: PDF_COLORS.muted });
  layout.gap(14);

  layout.text('Filters applied', { size: 11, bold: true });
  const filterLines = dataset.meta.filterSummary.length ? dataset.meta.filterSummary : ['No filters (all suppliers)'];
  for (const line of filterLines) {
    layout.text(`- ${line}`, { size: 10, color: PDF_COLORS.muted });
  }

  // ---- summary ------------------------------------------------------------
  layout.newPage();
  layout.heading('1. Summary');
  layout.kpiRow([
    { label: 'TOTAL SUPPLIERS', value: String(dataset.summary.totalSuppliers) },
    { label: 'TOTAL SPEND', value: formatMoney(dataset.summary.totalSpend, dataset.summary.currency) },
    { label: 'CLASSIFIED', value: formatPercent(dataset.summary.percentClassified), caption: `${dataset.summary.classified} suppliers` },
    { label: 'LOW CONFIDENCE', value: formatPercent(dataset.summary.percentLowConfidence), caption: `${dataset.summary.lowConfidence} to review` },
  ]);

  layout.kpiRow([
    { label: 'PARENTS', value: String(dataset.summary.parents) },
    { label: 'SUBSIDIARIES', value: String(dataset.summary.subsidiaries) },
    { label: 'INHERITED CODES', value: String(dataset.summary.inherited) },
    { label: 'STALE / UNENRICHED', value: String(dataset.summary.stale) },
  ]);

  layout.text(
    `Average confidence across classified suppliers: ${
      dataset.summary.averageConfidence === null ? 'n/a' : dataset.summary.averageConfidence.toFixed(2)
    }. Confidence threshold for review: ${dataset.summary.confidenceThreshold.toFixed(2)}. ${dataset.summary.reviewed} classification(s) have already been human-reviewed.`,
    { size: 9.5, color: PDF_COLORS.muted },
  );
  layout.gap(8);

  layout.heading('Top 10 parent companies by spend', 12);
  layout.table(
    [
      { header: 'Parent company', width: 200 },
      { header: 'UNSPSC', width: 60 },
      { header: 'Suppliers', width: 50, align: 'right' },
      { header: 'Subsidiaries', width: 60, align: 'right' },
      { header: 'Spend', width: 90, align: 'right' },
      { header: 'Low conf.', width: 45, align: 'right' },
    ],
    dataset.topParents.map((parent) => [
      parent.parentName,
      parent.unspscCode ?? '-',
      parent.supplierCount,
      parent.subsidiaryCount,
      formatMoney(parent.totalAmount, dataset.summary.currency),
      parent.lowConfidenceCount,
    ]),
  );

  // ---- segment breakdown ---------------------------------------------------
  layout.heading('2. UNSPSC segment breakdown', 13);
  layout.table(
    [
      { header: 'Seg', width: 34 },
      { header: 'Segment', width: 178 },
      { header: 'Suppliers', width: 52, align: 'right' },
      { header: 'Spend', width: 90, align: 'right' },
      { header: 'Share', width: 45, align: 'right' },
      { header: 'Avg conf.', width: 50, align: 'right' },
    ],
    dataset.segments.map((segment) => [
      segment.segmentCode,
      segment.segment,
      segment.suppliers,
      formatMoney(segment.spend, dataset.summary.currency),
      formatPercent(segment.spendShare),
      segment.avgConfidence === null ? '-' : segment.avgConfidence.toFixed(2),
    ]),
  );

  layout.gap(4);
  layout.text('Spend by segment', { size: 10, bold: true });
  layout.gap(4);
  layout.barChart(
    dataset.segments.slice(0, 12).map((segment) => ({
      label: `${segment.segmentCode} ${segment.segment}`,
      value: segment.spend,
      caption: `(${formatPercent(segment.spendShare)})`,
    })),
    { valueFormatter: (value) => formatMoney(value, dataset.summary.currency) },
  );

  // ---- hierarchy -----------------------------------------------------------
  layout.heading('3. Parent / subsidiary hierarchy', 13);
  const hierarchy = hierarchyRows(dataset);
  const maxHierarchyRows = options.maxHierarchyRows ?? 400;

  if (!hierarchy.length) {
    layout.text('No suppliers matched the current filters.', { size: 10, color: PDF_COLORS.muted });
  } else {
    const flattened: Array<Array<unknown>> = [];
    for (const parent of hierarchy) {
      flattened.push([
        parent.parentName,
        parent.parentCode ?? '-',
        'parent',
        parent.supplierCount,
        parent.subsidiaryCount,
        formatMoney(parent.totalAmount, dataset.summary.currency),
        parent.staleCount,
      ]);
      for (const subsidiary of parent.subsidiaries) {
        flattened.push([
          `    ${subsidiary.name}`,
          subsidiary.code ?? '-',
          'subsidiary',
          '',
          '',
          formatMoney(subsidiary.amount, dataset.summary.currency),
          '',
        ]);
      }
    }

    layout.table(
      [
        { header: 'Company', width: 185 },
        { header: 'UNSPSC', width: 58 },
        { header: 'Role', width: 55 },
        { header: 'Suppliers', width: 48, align: 'right' },
        { header: 'Subs.', width: 38, align: 'right' },
        { header: 'Spend', width: 88, align: 'right' },
        { header: 'Stale', width: 34, align: 'right' },
      ],
      flattened,
      { maxRows: maxHierarchyRows, fontSize: 8 },
    );
  }

  // ---- appendix ------------------------------------------------------------
  layout.newPage();
  layout.heading('4. Low-confidence review appendix', 13);
  layout.text(
    `Suppliers whose classification confidence is below ${dataset.summary.confidenceThreshold.toFixed(2)} and that have not been reviewed yet. Corrections made in the Review queue are fed back into the model as few-shot examples.`,
    { size: 9, color: PDF_COLORS.muted },
  );
  layout.gap(6);

  if (!dataset.lowConfidence.length) {
    layout.text('No low-confidence classifications. Nothing to review.', { size: 10, color: PDF_COLORS.muted });
  } else {
    layout.table(
      [
        { header: 'Supplier', width: 150 },
        { header: 'UNSPSC', width: 55 },
        { header: 'Commodity', width: 120 },
        { header: 'Conf.', width: 36, align: 'right' },
        { header: 'Parent', width: 105 },
        { header: 'Spend', width: 80, align: 'right' },
      ],
      dataset.lowConfidence.map((row) => [
        row.name,
        row.code ?? '-',
        row.commodity ?? '-',
        row.confidence === null ? '-' : row.confidence.toFixed(2),
        row.parentName ?? 'Independent',
        formatMoney(row.spend, dataset.summary.currency),
      ]),
      { maxRows: options.maxAppendixRows ?? 120, fontSize: 8 },
    );
  }

  layout.finish();
  return layout.doc.save();
}

/** Filename-safe report title. */
export function pdfFilename(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'report';
  return `${slug}.pdf`;
}

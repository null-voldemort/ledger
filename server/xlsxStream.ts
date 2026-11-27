import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

/**
 * A cell: plain text/number, or an object that adds a style id, and/or a formula.
 * `value` is what the file stores as the cached result of a formula, so viewers that do not
 * recalculate (previews, phones) still show the right figures.
 */
export type XlsxCell = string | number | null | { value: string | number | null; style?: number; formula?: string };
export type XlsxRow = readonly XlsxCell[] | { cells: readonly XlsxCell[]; height?: number };

export interface XlsxPageSetup {
  orientation?: 'portrait' | 'landscape';
  /** Print scaled to this many pages wide (default 1) and as many tall as needed. */
  fitToWidth?: number;
  /** Rows repeated at the top of every printed page, 1-based inclusive. */
  titleRows?: [number, number];
  /** Print only these columns (whole columns, so it works however many rows there are), e.g. ['A', 'J']. */
  printColumns?: [string, string];
  centerHorizontally?: boolean;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
}

export interface XlsxImage {
  data: Buffer; // PNG
  widthPx: number;
  heightPx: number;
  /** Zero-based anchor cell and a pixel nudge inside it. */
  col: number;
  row: number;
  offsetXPx?: number;
  offsetYPx?: number;
}

export interface XlsxSheet {
  name: string;
  rows: AsyncIterable<XlsxRow>;
  widths?: number[];
  showGridlines?: boolean;
  tabColor?: string;
  /** Freeze this many rows / columns at the top-left. */
  freeze?: { rows?: number; cols?: number };
  merges?: string[];
  page?: XlsxPageSetup;
  image?: XlsxImage;
  /** Called after every row has been written, for anything that depends on how many rows there were. */
  tail?: () => { autoFilter?: string; merges?: string[] };
}

// ---------------------------------------------------------------------------------------------
// Styles. A StyleBook collects fonts, fills, borders and number formats and hands back a style id
// (the cell's `style`). The default book keeps the three original ids so older exports are unchanged.
// ---------------------------------------------------------------------------------------------

export interface FontSpec { sz?: number; bold?: boolean; italic?: boolean; color?: string; name?: string }
export interface EdgeSpec { style: 'thin' | 'medium' | 'thick' | 'double' | 'hair'; color: string }
export interface BorderSpec { left?: EdgeSpec; right?: EdgeSpec; top?: EdgeSpec; bottom?: EdgeSpec }
export interface XfSpec {
  font?: FontSpec;
  fill?: string; // RGB hex without '#'
  border?: BorderSpec;
  numFmt?: string;
  h?: 'left' | 'center' | 'right';
  v?: 'top' | 'center' | 'bottom';
  wrap?: boolean;
  indent?: number;
}

export class StyleBook {
  private fonts: string[] = [];
  private fills: string[] = [];
  private borders: string[] = [];
  private numFmts: string[] = [];
  private xfs: string[] = [];

  constructor() {
    this.fontIndex({ sz: 11 });
    this.fontIndex({ sz: 11, bold: true, color: 'FFFFFF' });
    this.fills.push('<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>');
    this.fillIndex('1B2A4E');
    this.borders.push('<border><left/><right/><top/><bottom/><diagonal/></border>');
    this.numFmtId('#,##0.00;[Red]-#,##0.00'); // 164, the original money format
    this.xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
    this.xfs.push('<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>');
    this.xfs.push('<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>');
  }

  private intern(list: string[], xml: string): number {
    const found = list.indexOf(xml);
    if (found >= 0) return found;
    list.push(xml);
    return list.length - 1;
  }

  private fontIndex(f: FontSpec): number {
    const xml = '<font>' + (f.bold ? '<b/>' : '') + (f.italic ? '<i/>' : '') +
      `<sz val="${f.sz ?? 11}"/>` + (f.color ? `<color rgb="FF${f.color}"/>` : '') +
      `<name val="${xmlEscape(f.name ?? 'Calibri')}"/></font>`;
    return this.intern(this.fonts, xml);
  }

  private fillIndex(rgb: string): number {
    return this.intern(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`);
  }

  private borderIndex(b: BorderSpec): number {
    const edge = (tag: string, e?: EdgeSpec) => (e ? `<${tag} style="${e.style}"><color rgb="FF${e.color}"/></${tag}>` : `<${tag}/>`);
    return this.intern(this.borders, `<border>${edge('left', b.left)}${edge('right', b.right)}${edge('top', b.top)}${edge('bottom', b.bottom)}<diagonal/></border>`);
  }

  private numFmtId(code: string): number {
    const builtin: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4 };
    if (code in builtin) return builtin[code];
    const found = this.numFmts.indexOf(code);
    if (found >= 0) return 164 + found;
    this.numFmts.push(code);
    return 164 + this.numFmts.length - 1;
  }

  /** Register a cell style and return its id. Identical specs share one id. */
  xf(spec: XfSpec): number {
    const fontId = this.fontIndex(spec.font ?? {});
    const fillId = spec.fill ? this.fillIndex(spec.fill) : 0;
    const borderId = spec.border ? this.borderIndex(spec.border) : 0;
    const numFmtId = spec.numFmt ? this.numFmtId(spec.numFmt) : 0;
    const align = spec.h || spec.v || spec.wrap || spec.indent
      ? `<alignment${spec.h ? ` horizontal="${spec.h}"` : ''} vertical="${spec.v ?? 'center'}"${spec.wrap ? ' wrapText="1"' : ''}${spec.indent ? ` indent="${spec.indent}"` : ''}/>`
      : '';
    const xml = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1"` +
      `${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${numFmtId ? ' applyNumberFormat="1"' : ''}${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
    return this.intern(this.xfs, xml);
  }

  xml(): string {
    const fmts = this.numFmts.map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlEscape(code)}"/>`).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<numFmts count="${this.numFmts.length}">${fmts}</numFmts>` +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }
}

const defaultStyles = new StyleBook();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, bytes: Buffer): number {
  let value = crc;
  for (let i = 0; i < bytes.length; i += 1) value = CRC_TABLE[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let value = index + 1;
  let out = '';
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function cellXml(cell: XlsxCell, reference: string): string {
  if (cell === null || cell === undefined || cell === '') return '';
  const isObject = typeof cell === 'object';
  const value = isObject ? cell.value : cell;
  const styleId = isObject && cell.style ? cell.style : 0;
  const style = styleId ? ` s="${styleId}"` : '';
  const formula = isObject && cell.formula ? `<f>${xmlEscape(cell.formula)}</f>` : '';
  if (value === null || value === '') {
    // A styled blank (fills and borders) - but never an empty formula result.
    return styleId && !formula ? `<c r="${reference}"${style}/>` : '';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}>${formula}<v>${value}</v></c>`;
  }
  if (formula) return `<c r="${reference}" t="str"${style}>${formula}<v>${xmlEscape(value)}</v></c>`;
  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;
// Footer text may contain Excel codes such as &P (page) and &N (pages); a literal ampersand must be written as &&.
const footerText = (s?: string) => xmlEscape(s ?? '');

async function* worksheetXml(sheet: XlsxSheet, index: number): AsyncGenerator<Buffer> {
  const freezeRows = sheet.freeze?.rows ?? 0;
  const freezeCols = sheet.freeze?.cols ?? 0;
  const page = sheet.page;
  let head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
  head += `<sheetPr>${sheet.tabColor ? `<tabColor rgb="FF${sheet.tabColor}"/>` : ''}${page ? '<pageSetUpPr fitToPage="1"/>' : ''}</sheetPr>`;
  head += `<sheetViews><sheetView workbookViewId="0"${sheet.showGridlines === false ? ' showGridLines="0"' : ''}${index === 0 ? ' tabSelected="1"' : ''}>`;
  if (freezeRows || freezeCols) {
    const topLeft = `${columnName(freezeCols)}${freezeRows + 1}`;
    const pane = freezeRows && freezeCols ? 'bottomRight' : freezeRows ? 'bottomLeft' : 'topRight';
    head += `<pane${freezeCols ? ` xSplit="${freezeCols}"` : ''}${freezeRows ? ` ySplit="${freezeRows}"` : ''} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/>` +
      `<selection pane="${pane}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
  }
  head += '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
  if (sheet.widths?.length) {
    head += '<cols>' + sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
  }
  head += '<sheetData>';
  yield Buffer.from(head, 'utf8');

  let rowNumber = 0;
  for await (const row of sheet.rows) {
    rowNumber += 1;
    if (rowNumber > 1_048_576) throw new Error('XLSX worksheets cannot exceed 1,048,576 rows. Use CSV for a larger export.');
    const cellsIn = Array.isArray(row) ? (row as readonly XlsxCell[]) : (row as { cells: readonly XlsxCell[] }).cells;
    const height = Array.isArray(row) ? undefined : (row as { height?: number }).height;
    let cells = '';
    for (let column = 0; column < cellsIn.length; column += 1) {
      cells += cellXml(cellsIn[column], `${columnName(column)}${rowNumber}`);
    }
    yield Buffer.from(`<row r="${rowNumber}"${height ? ` ht="${height}" customHeight="1"` : ''}>${cells}</row>`, 'utf8');
  }

  const tail = sheet.tail?.() ?? {};
  let end = '</sheetData>';
  if (tail.autoFilter) end += `<autoFilter ref="${tail.autoFilter}"/>`;
  const merges = [...(sheet.merges ?? []), ...(tail.merges ?? [])];
  if (merges.length) end += `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`;
  if (page) {
    if (page.centerHorizontally) end += '<printOptions horizontalCentered="1"/>';
    end += '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.25" footer="0.3"/>';
    end += `<pageSetup paperSize="9" orientation="${page.orientation ?? 'portrait'}" fitToWidth="${page.fitToWidth ?? 1}" fitToHeight="0"/>`;
    if (page.footerLeft || page.footerCenter || page.footerRight) {
      end += '<headerFooter><oddFooter>' +
        `&amp;L${footerText(page.footerLeft)}&amp;C${footerText(page.footerCenter)}&amp;R${footerText(page.footerRight)}` +
        '</oddFooter></headerFooter>';
    }
  }
  if (sheet.image) end += '<drawing r:id="rId1"/>';
  end += '</worksheet>';
  yield Buffer.from(end, 'utf8');
}

function drawingXml(image: XlsxImage): string {
  const emu = (px: number) => Math.round(px * 9525);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<xdr:oneCellAnchor><xdr:from>' +
    `<xdr:col>${image.col}</xdr:col><xdr:colOff>${emu(image.offsetXPx ?? 0)}</xdr:colOff><xdr:row>${image.row}</xdr:row><xdr:rowOff>${emu(image.offsetYPx ?? 0)}</xdr:rowOff>` +
    `</xdr:from><xdr:ext cx="${emu(image.widthPx)}" cy="${emu(image.heightPx)}"/>` +
    '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo" descr="Pace IT logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    '<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(image.widthPx)}" cy="${emu(image.heightPx)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
}

function workbookParts(sheets: XlsxSheet[], options: XlsxWorkbookOptions) {
  const styles = options.styles ?? defaultStyles;
  const hasImages = sheets.some((s) => s.image);
  const overrides = sheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    (sheets[index].image ? `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : ''),
  ).join('');
  const sheetEntries = sheets.map((s, index) =>
    `<sheet name="${xmlEscape(s.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const relationships = sheets.map((_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');

  const definedNames: string[] = [];
  sheets.forEach((s, index) => {
    if (s.page?.printColumns) {
      definedNames.push(`<definedName name="_xlnm.Print_Area" localSheetId="${index}">${xmlEscape(quoteSheet(s.name))}!$${s.page.printColumns[0]}:$${s.page.printColumns[1]}</definedName>`);
    }
    if (s.page?.titleRows) {
      definedNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${xmlEscape(quoteSheet(s.name))}!$${s.page.titleRows[0]}:$${s.page.titleRows[1]}</definedName>`);
    }
  });

  const parts: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${hasImages ? '<Default Extension="png" ContentType="image/png"/>' : ''}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetEntries}</sheets>${definedNames.length ? `<definedNames>${definedNames.join('')}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': styles.xml(),
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${xmlEscape(options.creator ?? 'Pace IT Ledger')}</dc:creator><dc:title>${xmlEscape(options.title ?? 'Ledger Export')}</dc:title></cp:coreProperties>`,
  };
  sheets.forEach((s, index) => {
    if (!s.image) return;
    parts[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${index + 1}.xml"/></Relationships>`;
    parts[`xl/drawings/drawing${index + 1}.xml`] = drawingXml(s.image);
    parts[`xl/drawings/_rels/drawing${index + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index + 1}.png"/></Relationships>`;
  });
  return parts;
}

interface ZipEntryInfo {
  name: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

export interface XlsxWorkbookOptions {
  styles?: StyleBook;
  title?: string;
  creator?: string;
}

export async function* streamXlsxWorkbook(sheets: XlsxSheet[], options: XlsxWorkbookOptions = {}): AsyncGenerator<Buffer> {
  if (sheets.length < 1 || sheets.length > 4) throw new Error('An export workbook must contain between one and four worksheets.');
  const names = new Set<string>();
  for (const sheet of sheets) {
    if (!/^[A-Za-z0-9 _-]{1,31}$/.test(sheet.name) || names.has(sheet.name)) throw new Error('Invalid worksheet name.');
    names.add(sheet.name);
  }

  const parts: Record<string, string> = workbookParts(sheets, options);
  const entries: Array<{ name: string; chunks: AsyncIterable<Buffer> }> = Object.entries(parts).map(([name, xml]) => ({
    name,
    chunks: (async function* () { yield Buffer.from(xml, 'utf8'); })(),
  }));
  sheets.forEach((sheet, index) => entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, chunks: worksheetXml(sheet, index) }));
  sheets.forEach((sheet, index) => {
    if (!sheet.image) return;
    const image = sheet.image;
    entries.push({ name: `xl/media/image${index + 1}.png`, chunks: (async function* () { yield image.data; })() });
  });

  const centralDirectory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const fileName = Buffer.from(entry.name, 'utf8');
    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 filename
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(0, 18);
    localHeader.writeUInt32LE(0, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileName.copy(localHeader, 30);
    yield localHeader;

    let crc = 0xffffffff;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const source = Readable.from(entry.chunks);
    const crcTap = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = updateCrc32(crc, bytes);
        uncompressedSize += bytes.length;
        callback(null, bytes);
      },
    });
    const deflater = createDeflateRaw({ level: 6 });
    const output = new PassThrough();
    const completed = pipeline(source, crcTap, deflater, output);
    try {
      for await (const chunk of output) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        compressedSize += bytes.length;
        if (compressedSize > 0xffffffff || uncompressedSize > 0xffffffff) {
          throw new Error('Export exceeds the supported 4 GB XLSX worksheet size.');
        }
        yield bytes;
      }
      await completed;
    } catch (error) {
      source.destroy();
      crcTap.destroy();
      deflater.destroy();
      output.destroy();
      try { await completed; } catch { }
      throw error;
    }

    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
    yield descriptor;

    const central = Buffer.alloc(46 + fileName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    fileName.copy(central, 46);
    centralDirectory.push(central);

    offset += localHeader.length + compressedSize + descriptor.length;
  }

  const centralOffset = offset;
  if (centralOffset > 0xffffffff) throw new Error('Export exceeds the supported 4 GB XLSX workbook size.');
  const centralSize = centralDirectory.reduce((total, entry) => total + entry.length, 0);
  for (const entry of centralDirectory) {
    yield entry;
    offset += entry.length;
  }
  if (offset > 0xffffffff) throw new Error('Export exceeds the supported 4 GB XLSX workbook size.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralDirectory.length, 8);
  end.writeUInt16LE(centralDirectory.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}

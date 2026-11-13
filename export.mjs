import {statuses} from './reconcile.mjs';

const spreadsheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
const encodeXlsx = new TextEncoder();
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// XLSX is a ZIP of XML parts. Store the parts directly so export also works offline.
function zipXml(parts) {
  const records = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;

  for (const [path, content] of Object.entries(parts)) {
    const name = encodeXlsx.encode(path);
    const data = encodeXlsx.encode(xmlHeader + content);
    const checksum = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 33, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    records.push(local.buffer, name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(14, 33, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    directory.push(central.buffer, name);
    offset += 30 + name.length + data.length;
    directorySize += 46 + name.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, directory.length / 2, true);
  end.setUint16(10, directory.length / 2, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...records, ...directory, end.buffer], {type: mimeType});
}

function xmlText(value) {
  return String(value).slice(0, 32767)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')
    .replace(/_x[\da-f]{4}_/gi, match => '_x005F_' + match.slice(1))
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

const columnLetter = index => String.fromCharCode(65 + index);

function makeSheet(rows, widths, {filter = false, currency = []} = {}) {
  const columns = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
  const sheetData = rows.map((values, index) => {
    const row = index + 1;
    const cells = values.map((value, column) => {
      if (value == null || value === '') return '';
      const ref = columnLetter(column) + row;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}" s="${currency.includes(column) ? 3 : 0}"><v>${value}</v></c>`;
      }
      return `<c r="${ref}" s="${index === 0 ? 1 : 2}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    }).join('');
    const lines = Math.max(1, ...values.map((value, column) => typeof value === 'string'
      ? value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / (widths[column] - 3))), 0)
      : 1));
    const height = index === 0 ? 25 : Math.min(108, Math.max(20, lines * 15 + 5));
    return `<row r="${row}" ht="${height}" customHeight="1">${cells}</row>`;
  }).join('');
  const range = `A1:${columnLetter(widths.length - 1)}${rows.length}`;
  return `<worksheet xmlns="${spreadsheetNs}"><dimension ref="${range}"/>
    <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    <selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
    <sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols>
    <sheetData>${sheetData}</sheetData>${filter ? `<autoFilter ref="${range}"/>` : ''}</worksheet>`;
}

const exportStyles = `<styleSheet xmlns="${spreadsheetNs}">
  <fonts count="2"><font><sz val="11"/><color rgb="FF152128"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF005C66"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1" applyFill="1" applyFont="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function createResultsWorkbook(entries, summary, source) {
  const summaryRows = [['Показатель', 'Значение'], ...summary, ['Исходная книга', source]];
  const details = [
    ['Письмо', 'Получено', 'Поставщик', 'Счёт', 'Заказ', 'Статус', 'Сумма, ₽', 'Расхождение, ₽',
      'Причина', 'Следующий шаг', 'Кому', 'Связанное письмо', 'Правила'],
    ...entries.map(entry => [
      entry.id, entry.received, entry.sender, entry.invoice, entry.order?.id ?? entry.statedOrder,
      statuses[entry.status][0], entry.amount, entry.delta, entry.explanation, entry.action,
      entry.recipient, entry.related, entry.rules.join(', '),
    ]),
  ];
  return zipXml({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageRelationships}">
      <Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheetNs}" xmlns:r="${officeRelationships}">
      <bookViews><workbookView activeTab="0"/></bookViews>
      <sheets><sheet name="Сводка" sheetId="1" r:id="rId1"/><sheet name="Результаты" sheetId="2" r:id="rId2"/></sheets>
    </workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageRelationships}">
      <Relationship Id="rId1" Type="${officeRelationships}/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="${officeRelationships}/worksheet" Target="worksheets/sheet2.xml"/>
      <Relationship Id="rId3" Type="${officeRelationships}/styles" Target="styles.xml"/>
    </Relationships>`,
    'xl/styles.xml': exportStyles,
    'xl/worksheets/sheet1.xml': makeSheet(summaryRows, [29, 48]),
    'xl/worksheets/sheet2.xml': makeSheet(details, [14, 18, 27, 13, 13, 25, 17, 20, 58, 58, 32, 22, 24],
      {filter: true, currency: [6, 7]}),
  });
}

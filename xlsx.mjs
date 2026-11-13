const MAX_FILE = 12 * 1024 * 1024;
const MAX_XML = 16 * 1024 * 1024;
const decoder = new TextDecoder();

// Read the central directory so entries with ZIP data descriptors work as well.
function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const u16 = position => view.getUint16(position, true);
  const u32 = position => view.getUint32(position, true);
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && u32(end) !== 0x06054b50) end--;
  if (end < minimum) throw new Error('Файл не похож на книгу XLSX.');
  const entries = new Map();
  let offset = u32(end + 16);
  for (let index = 0; index < u16(end + 10); index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw new Error('Повреждён каталог XLSX.');
    const method = u16(offset + 10);
    const size = u32(offset + 20);
    const expanded = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const filename = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const local = u32(offset + 42);
    entries.set(filename, {local, size, expanded, method});
    offset += 46 + nameLength + u16(offset + 30) + u16(offset + 32);
  }
  return async filename => {
    const entry = entries.get(filename);
    if (!entry) return null;
    const {local, size, expanded, method} = entry;
    if (local + 30 > end || u32(local) !== 0x04034b50 || expanded > MAX_XML) {
      throw new Error('Невозможно прочитать содержимое XLSX.');
    }
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + size > end) throw new Error('Файл XLSX повреждён.');
    const compressed = bytes.subarray(start, start + size);
    if (method === 0) return decoder.decode(compressed);
    if (method !== 8) throw new Error('В XLSX используется неподдерживаемое сжатие.');
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_XML) {
        await reader.cancel();
        throw new Error('Лист слишком большой для пилота.');
      }
      chunks.push(value);
    }
    return new Blob(chunks).text();
  };
}

function parseXml(text) {
  if (!text) throw new Error('В книге отсутствует обязательный файл.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Некорректная структура листа XLSX.');
  return doc;
}

const elements = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const allText = node => elements(node, 't').map(item => item.textContent).join('');

function readSheet(text, shared) {
  const rows = [];
  for (const node of elements(parseXml(text), 'row')) {
    const rowNumber = Number(node.getAttribute('r') || rows.length + 1);
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 5000) throw new Error('Лист слишком большой для пилота.');
    const row = [];
    for (const cell of elements(node, 'c')) {
      const address = cell.getAttribute('r') ?? '';
      const letters = address.match(/^[A-Z]+/)?.[0];
      const column = letters ? [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1 : row.length;
      if (column > 30) continue;
      const type = cell.getAttribute('t');
      const raw = elements(cell, 'v')[0]?.textContent;
      if (type === 'inlineStr') row[column] = allText(cell);
      else if (type === 's') row[column] = shared[Number(raw)] ?? null;
      else if (type === 'e' || raw == null) row[column] = null;
      else row[column] = type === 'n' || !type ? Number(raw) : raw;
    }
    rows[rowNumber - 1] = row;
  }
  return Array.from(rows, row => row ?? []);
}

export async function readWorkbook(file) {
  if (file.size > MAX_FILE) throw new Error('Размер XLSX превышает 12 МБ.');
  const get = unzip(await file.arrayBuffer());
  const [book, relationships, strings] = await Promise.all([
    get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'), get('xl/sharedStrings.xml'),
  ]);
  const paths = new Map(elements(parseXml(relationships), 'Relationship').map(item => [
    item.getAttribute('Id'), item.getAttribute('Target'),
  ]));
  const shared = strings ? elements(parseXml(strings), 'si').map(allText) : [];
  const sheets = await Promise.all(elements(parseXml(book), 'sheet').map(async sheet => {
    const id = [...sheet.attributes].find(attribute => attribute.localName === 'id')?.value;
    const target = paths.get(id);
    if (!target) throw new Error('Не удалось найти лист в книге.');
    const path = new URL(target, 'https://xlsx.invalid/xl/workbook.xml').pathname.slice(1);
    return [sheet.getAttribute('name'), readSheet(await get(path), shared)];
  }));
  return Object.fromEntries(sheets);
}

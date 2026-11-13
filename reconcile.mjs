export const statuses = {
  ready: ['Сверен', 'green'],
  review: ['Нужно уточнение', 'amber'],
  fix: ['Нужно исправление', 'amber'],
  hold: ['Проверить реквизиты', 'red'],
  duplicate: ['Повтор', 'muted'],
  replaced: ['Заменён', 'muted'],
  info: ['Переписка', 'muted'],
};

const names = ['Счета и письма', 'Заказы и приёмка', 'Согласования', 'Правила'];
const clean = value => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/["«»]/g, '').trim();
const supplierName = value => clean(String(value ?? '').split(',')[0]);
const orderId = value => String(value ?? '').toUpperCase().replace(/\s*[-–—]\s*/g, '-');
const invoiceId = value => String(value ?? '').replace(/^0+(?=\d)/, '');
const number = value => value == null ? null : Number(String(value).replace(/\s/g, '').replace(',', '.'));
const numeric = String.raw`\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?`;
const units = String.raw`шт(?:ук[аи]?)?|кг|рул(?:он(?:а|ов|ы)?)?|меш(?:ок|ка|ков)|пач(?:ка|ки|ек)`;
const unit = value => clean(value).match(/^(шт|кг|рул|меш|пач)/)?.[0] ?? '';
const paidUnit = new RegExp(String.raw`(?<qty>${numeric})\s*(?<unit>${units})\.?\s*(?:(?:по|×|x)\s*(?<pack>${numeric})\s*(?<packUnit>${units})\.?\s*,?\s*)?(?:,\s*)?(?:по\s+|цена\s*(?:(?:за\s+)?[\p{L}.]+\s+)?)(?<price>${numeric})\s*(?:₽|руб)`, 'iu');
const quantityOnly = new RegExp(String.raw`(?<qty>${numeric})\s*(?<unit>${units})(?!\p{L})`, 'iu');
const amountPattern = new RegExp(String.raw`(?:итого|всего|на\s+сумму)\s*[:=]?\s*(${numeric})\s*(?:₽|руб)`, 'iu');
const invoicePattern = /сч[её]т[уае]?\s*(?:№\s*)?([\p{L}]*\d[\p{L}\d/-]*)/iu;
const orderPattern = /ЗП\s*[-–—]\s*\d+/iu;
const changePattern = /нов\p{L}*\s+(?:банковск\p{L}*\s+)?реквизит|смен\p{L}*\s+(?:банк|получател)|другой фирм|новый расч[её]тный сч[её]т/iu;
const money = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(value) + ' ₽';
const qty = (value, unitName) => `${new Intl.NumberFormat('ru-RU').format(value)} ${unitName}`;
const difference = (left, right) => Math.round((left - right) * 100) / 100;

function dateKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10).replaceAll('-', ''));
  }
  const match = String(value ?? '').match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
  return match ? Number(`${match[3] ?? '2026'}${match[2].padStart(2, '0')}${match[1].padStart(2, '0')}`) : null;
}

function measurements(value) {
  const text = clean(value).replace(/(\d)\s*[хx×]\s*(?=\d)/g, '$1×');
  const dimensions = text.match(/\d+(?:×\d+)+/g) ?? [];
  const specs = [...text.matchAll(/(?:^|[^\d×])(\d+(?:[.,]\d+)?)\s*(мкм|мм|кг|г|м)(?!\p{L})/gu)];
  const groups = new Map();
  for (const [, count, measureUnit] of specs) {
    const group = ['г', 'кг'].includes(measureUnit) ? 'масса' : measureUnit;
    const values = groups.get(group) ?? [];
    values.push(number(count) * (measureUnit === 'кг' ? 1000 : 1));
    groups.set(group, values);
  }
  return {dimensions, groups};
}

function materialConflict(left, right) {
  const a = measurements(left);
  const b = measurements(right);
  if (a.dimensions.length && b.dimensions.length && !a.dimensions.some(size => b.dimensions.includes(size))) return true;
  for (const [key, values] of a.groups) {
    if (b.groups.has(key) && !values.some(value => b.groups.get(key).includes(value))) return true;
  }
  return false;
}

function readMessage([id, received, sender, body], row) {
  const text = String(body ?? '');
  const charge = text.match(paidUnit);
  const quantity = charge ?? text.match(quantityOnly);
  const prefix = quantity ? text.slice(0, quantity.index) : '';
  const material = prefix.slice(prefix.indexOf(':') + 1).replace(/^[\s\S]*?сч[её]т\s+№?\s*[\w/-]+\s*(?:за\s+)?/iu, '').trim().replace(/,\s*$/, '');
  const {qty, unit: chargeUnit, pack, packUnit, price} = quantity?.groups ?? {};
  const invoice = text.match(invoicePattern)?.[1] ?? '';
  const amount = number(text.match(amountPattern)?.[1]);
  const order = orderId(text.match(orderPattern)?.[0]);
  const rawQuantity = number(qty);
  const rawPrice = number(price);
  const packageSize = number(pack);
  const orderDate = text.match(/заказ[ау]?\s+от\s+(\d{1,2}\.\d{1,2}(?:\.\d{4})?)/iu)?.[1];
  const replacement = /исправленн\p{L}*\s+сч[её]т|в прошлой версии/iu.test(text);
  const resend = /пересылаем повторно|дубликат|повторно присылаем/iu.test(text);
  const changesPayee = changePattern.test(text);
  const deliveryPromise = text.match(/(?:привез[её]м|привез[её]т|отгрузим|поставим)\s+(?:до\s+|к\s+)?(\d{1,2}\.\d{1,2}(?:\.\d{4})?)/iu)?.[1];
  const looksLikeBill = /^(?:(?:новый|исправленный)\s+)?сч[её]т\s/iu.test(text)
    || Boolean(invoice && (rawPrice != null || resend || /выставляем\s+сч[её]т/iu.test(text)));
  return {
    id, row, received, sender, text, invoice, amount, order, material, orderDate,
    replacement, resend, changesPayee, looksLikeBill, deliveryPromise,
    party: supplierName(sender), rawQuantity, rawPrice, packageSize,
    rawUnit: unit(chargeUnit), packUnit: unit(packUnit),
  };
}

function readOrder([id, date, supplier, buyer, material, orderUnit, ordered, received, receiptDate, price], row) {
  return {
    id: orderId(id), row, date, supplier, buyer, material, unit: unit(orderUnit),
    ordered: number(ordered), received: number(received), receiptDate, price: number(price),
    party: supplierName(supplier),
  };
}

function inOrderUnits(message, order) {
  if (message.rawQuantity == null) return null;
  if (message.rawUnit === order.unit && !message.packageSize) {
    return {quantity: message.rawQuantity, price: message.rawPrice};
  }
  if (message.packUnit === order.unit && message.packageSize > 0) {
    return {quantity: message.rawQuantity * message.packageSize, price: message.rawPrice / message.packageSize};
  }
  return null;
}

function findOrder(message, orders) {
  if (message.order) return orders.get(message.order);
  const {dimensions, groups} = measurements(message.material);
  const candidates = [...orders.values()].filter(order => order.party === message.party
    && !materialConflict(message.material, order.material));
  const matches = candidates.filter(order => {
    const converted = inOrderUnits(message, order);
    const reference = measurements(order.material);
    const sharedDimension = dimensions.some(size => reference.dimensions.includes(size));
    const sharedSpec = [...groups].some(([key, values]) => values.some(value => reference.groups.get(key)?.includes(value)));
    const sameMaterial = clean(message.material) === clean(order.material);
    return (sharedDimension || sharedSpec || sameMaterial)
      && converted?.quantity === order.ordered
      && (!message.orderDate || dateKey(message.orderDate) === dateKey(order.date));
  });
  return matches.length === 1 ? matches[0] : null;
}

function relatedVersion(message, previous, order) {
  if (!message.invoice || !message.party) return null;
  const normalized = invoiceId(message.invoice);
  const exact = previous.find(item => item.party === message.party && invoiceId(item.invoice) === normalized);
  if (exact) return exact;
  return previous.find(item => item.party === message.party
    && normalized.split('/')[0] === invoiceId(item.invoice).split('/')[0]
    && (normalized.includes('/') || item.invoice.includes('/'))
    && order && item.order?.id === order.id
    && item.amount != null && item.amount === message.amount
    && item.rawQuantity === message.rawQuantity && item.rawPrice === message.rawPrice);
}

function outcome(status, title, explanation, action, rules, recipient = '', draft = '') {
  return {status, title, explanation, action, rules, recipient, draft};
}

function orderTerms(order, changes) {
  let price = order.price;
  let ordered = order.ordered;
  let uncertain = false;
  const notes = [];
  for (const change of changes) {
    if (!change.signed) {
      notes.push(`${change.id} · ${change.status}`);
      continue;
    }
    const text = change.text;
    const newPrice = text.match(new RegExp(String.raw`(${numeric})\s*(?:₽|руб)`, 'iu'));
    const newQuantity = text.match(/количество\s+\p{L}+\s+с\s+\d+\s+до\s+(\d+)/iu);
    const starts = text.match(/(?:поставок\s+с|вступает\s+в\s+силу\s+с)\s+(\d{1,2}\.\d{1,2}(?:\.\d{4})?)/iu);
    if (starts) {
      if (dateKey(order.receiptDate) == null || dateKey(order.receiptDate) >= dateKey(starts[1])) {
        uncertain = true;
        notes.push(`${change.id} · нужно подтвердить дату партии для цены с ${starts[1]}`);
      } else {
        notes.push(`${change.id} · действует с ${starts[1]}, после приёмки`);
      }
      continue;
    }
    if (newQuantity) ordered = number(newQuantity[1]);
    if (newPrice && /^цена\s/iu.test(text)) price = number(newPrice[1]);
    notes.push(`${change.id} · подписано`);
  }
  return {price, ordered, uncertain, notes};
}

function check(message, order, changes, payeeMessages, earlier) {
  const {invoice, amount, rawQuantity, rawPrice} = message;
  const id = order?.id ?? message.order;
  const buyer = order?.buyer || 'Закупщик';
  const ask = (title, explanation, action, rules, recipient = buyer, draft) =>
    outcome('review', title, explanation, action, rules, recipient, draft);
  if (message.changesPayee || payeeMessages.length || (order && order.party !== message.party)) {
    const related = payeeMessages[0];
    return outcome('hold', 'Нужно подтвердить получателя платежа',
      related ? `В письме ${related.id} поставщик просит сменить реквизиты по счёту №${invoice}.`
        : 'В письме заявлена смена получателя или банка либо поставщик расходится с данными заказа.',
      'Передать закупщику и финансовому директору для проверки подписанного допсоглашения в Directum RX.',
      ['П-2'], `${buyer} и финансовый директор`,
      `По счёту №${invoice || '—'}${id ? `, заказ ${id}` : ''} требуется подтверждение реквизитов. Проверьте, пожалуйста, подписанное допсоглашение и актуального получателя платежа в Directum RX.`);
  }
  if (!order) return ask('Заказ требует уточнения',
    id ? `Заказ ${id} отсутствует в выгрузке.` : 'По поставщику, материалу, количеству и дате не удалось однозначно определить заказ.',
    'Запросить номер заказа и уточнить принадлежность счёта.', ['П-1'],
    buyer, `Уточните, пожалуйста, номер заказа для счёта №${invoice || '—'} от «${message.sender.split(',')[0].replace(/[«»]/g, '')}».`);
  if (!invoice) return ask('Не указан номер счёта', 'Номер нужен для проверки повторов у поставщика.',
    'Запросить номер документа.', ['П-1', 'П-3'], buyer,
    `Уточните, пожалуйста, номер счёта по заказу ${id}.`);
  if (rawQuantity == null || rawPrice == null || amount == null || rawQuantity <= 0 || rawPrice < 0 || amount < 0) {
    return ask('Не хватает данных счёта', 'Для сверки нужны количество, цена за единицу и итоговая сумма.',
      'Уточнить данные позиции по оригиналу счёта.', ['П-7', 'П-8'], buyer,
      `По счёту №${invoice} к заказу ${id} уточните, пожалуйста, количество, единицу измерения, цену и итоговую сумму.`);
  }
  const expected = Math.round(rawQuantity * rawPrice * 100) / 100;
  if (difference(amount, expected)) {
    return {...outcome('fix', 'Итог счёта не сходится',
      `${qty(rawQuantity, message.rawUnit)} × ${money(rawPrice)} = ${money(expected)}. В счёте указано ${money(amount)}.`,
      'Запросить исправленный счёт у поставщика.', ['П-8'], order.supplier,
      `По счёту №${invoice}, заказ ${id}, расчёт по позиции даёт ${money(expected)}, а в документе указано ${money(amount)}. Пришлите, пожалуйста, исправленный счёт.`),
    delta: difference(amount, expected)};
  }
  if (materialConflict(message.material, order.material)) {
    return ask('Характеристики товара различаются', `В заказе ${id} указан материал «${order.material}». Характеристики в счёте отличаются.`,
      'Уточнить у закупщика, к какой позиции относится счёт.', ['П-1', 'П-7'], buyer,
      `Подтвердите, пожалуйста, материал в счёте №${invoice} по заказу ${id}. В ERP указано «${order.material}».`);
  }
  const converted = inOrderUnits(message, order);
  if (!converted) return ask('Нужно подтвердить фасовку', `Счёт в единице «${message.rawUnit || 'не указана'}», заказ в «${order.unit}».`,
    'Запросить коэффициент пересчёта в единицу заказа.', ['П-7'], buyer,
    `Уточните, пожалуйста, фасовку в счёте №${invoice} по заказу ${id}, чтобы пересчитать позицию в «${order.unit}».`);
  const terms = orderTerms(order, changes);
  const {quantity, price} = converted;
  const remaining = order.received - earlier;
  const extras = {...converted, terms, earlier};
  const futureLot = message.deliveryPromise && (dateKey(order.receiptDate) == null
    || dateKey(message.deliveryPromise) > dateKey(order.receiptDate));
  const shortage = futureLot || order.received == null || quantity > remaining;
  if (shortage) {
    const receipt = futureLot ? `В счёте указана отдельная партия к ${message.deliveryPromise}. Её приёмка в выгрузке не подтверждена.`
      : order.received == null ? 'Данные о проведённой приёмке отсутствуют.'
      : `В счёте ${qty(quantity, order.unit)}, в учёте принято ${qty(order.received, order.unit)}${earlier ? `, в других сверенных счетах уже учтено ${qty(earlier, order.unit)}` : ''}.`;
    return {...ask('Не хватает проведённой приёмки', receipt,
      'Запросить условия оплаты и предоплаты у закупщика. При необходимости подтвердить поступление у склада.',
      ['П-4', 'П-5', 'П-9'], buyer,
      `По счёту №${invoice}, заказ ${id}: ${receipt} Подтвердите, пожалуйста, условия оплаты и предоплаты по договору.`), ...extras};
  }
  if (terms.ordered == null || quantity + earlier > terms.ordered) {
    return {...ask('Количество выше согласованного',
      `С учётом других сверенных счетов предъявлено ${qty(quantity + earlier, order.unit)}. В заказе согласовано ${terms.ordered == null ? 'не указано' : qty(terms.ordered, order.unit)}.`,
      'Уточнить у закупщика, как оформить сверхпоставку.', ['П-6', 'П-9'], buyer,
      `По счёту №${invoice} к заказу ${id} количество выше согласованного. Подтвердите, пожалуйста, основание для сверхпоставки.`), ...extras};
  }
  if (terms.uncertain || terms.price == null || Math.abs(price - terms.price) > 0.000001) {
    const delta = terms.uncertain || terms.price == null ? null : difference(amount, quantity * terms.price);
    const explanation = terms.uncertain || terms.price == null
      ? 'Выгрузки недостаточно, чтобы подтвердить действующую цену этой партии.'
      : `В счёте ${money(price)} за ${order.unit}, действует ${money(terms.price)} за ${order.unit}. Расхождение по сумме — ${money(delta)}.`;
    return {...ask('Нужно подтвердить цену', explanation,
      'Проверить у закупщика подписанное согласование для этого заказа и партии.', ['П-6', 'П-9'], buyer,
      `По счёту №${invoice}, заказ ${id}: ${explanation} Подтвердите, пожалуйста, действующую цену и пришлите основание.`),
    ...extras, delta};
  }
  const conversion = message.packageSize
    ? `${qty(rawQuantity, message.rawUnit)} × ${qty(message.packageSize, order.unit)} = ${qty(quantity, order.unit)}. ` : '';
  return {...outcome('ready', 'Данные счёта сходятся',
    `${conversion}Подтверждено ${qty(quantity, order.unit)} по ${money(price)}. Итог — ${money(amount)}.`,
    'Передать бухгалтеру для дальнейшей проверки перед подготовкой платежа.', ['П-1', 'П-4', 'П-6', 'П-7', 'П-8']), ...extras};
}

export function reconcile(workbook, added = []) {
  if (!names.every(name => Array.isArray(workbook?.[name]) && workbook[name].length >= 3)) {
    throw new Error('Нужны четыре листа из шаблона кейса: счета и письма, заказы и приёмка, согласования, правила.');
  }
  const [mailRows, orderRows, changeRows, ruleRows] = names.map(name => workbook[name]);
  const orders = new Map(orderRows.slice(3).map((row, i) => readOrder(row, i + 4)).filter(row => row.id).map(row => [row.id, row]));
  const changes = changeRows.slice(3).map(([id, date, order, text, status, signer], index) => ({
    id, date, order: orderId(order), text: String(text ?? ''), status, signer,
    signed: clean(status) === 'подписано' && Boolean(signer), row: index + 4,
  })).filter(change => change.id);
  const rules = Object.fromEntries(ruleRows.slice(3).filter(row => row[0]).map(([id, title, text]) => [id, {title, text}]));
  const messages = [...mailRows.slice(3), ...added].map((row, index) => readMessage(row, index + 4)).filter(row => row.id && row.text);
  const checked = [];
  const active = [];
  for (const message of messages) {
    const matchedOrder = findOrder(message, orders);
    const version = relatedVersion(message, active, matchedOrder);
    const order = matchedOrder ?? (!message.looksLikeBill ? version?.order : null);
    const applicable = changes.filter(change => change.order === order?.id);
    const entry = {...message, statedOrder: message.order, order, changes: applicable};
    if (!message.looksLikeBill) {
      const result = message.changesPayee ? check(message, order, applicable, [], 0)
        : outcome('info', 'Письмо для справки', 'Это сообщение дополняет переписку по заказу или счёту.',
          'Использовать как контекст при проверке исходного документа.', ['П-1', 'П-4']);
      checked.push({...entry, ...result, related: version?.id});
      continue;
    }
    const sameOrder = !order || !version?.order || order.id === version.order.id;
    if (version && sameOrder && message.replacement) {
      Object.assign(version, outcome('replaced', 'Есть исправленная версия',
        `Актуальная версия счёта получена в письме ${message.id}.`, 'Открыть исправленный счёт.', ['П-3']),
      {related: message.id, delta: null, terms: null});
      active.splice(active.indexOf(version), 1);
    } else if (version && sameOrder && (message.resend || (message.amount != null
      && message.amount === version.amount && message.rawQuantity === version.rawQuantity
      && message.rawPrice === version.rawPrice && message.rawUnit === version.rawUnit
      && message.packageSize === version.packageSize && message.packUnit === version.packUnit))) {
      checked.push({...entry, ...outcome('duplicate', 'Счёт уже есть в очереди',
        `Письмо относится к счёту №${version.invoice} от того же поставщика (${version.id}).`,
        'Открыть исходный счёт.', ['П-1', 'П-3']), related: version.id});
      continue;
    } else if (version) {
      checked.push({...entry, ...outcome('review', 'Данные версий расходятся',
        `У этого поставщика уже есть счёт с таким номером в письме ${version.id}.`,
        'Уточнить, относится ли письмо к исправлению исходного счёта или к новой партии.', ['П-3']), related: version.id});
      continue;
    }
    const payee = messages.filter(other => other.id !== message.id && other.party === message.party && other.changesPayee
      && other.invoice && message.invoice && invoiceId(other.invoice) === invoiceId(message.invoice));
    const earlier = active.filter(item => order && item.order?.id === order.id && item.status === 'ready')
      .reduce((sum, item) => sum + item.quantity, 0);
    const result = {...entry, ...check(message, order, applicable, payee, earlier), related: payee[0]?.id};
    active.push(result);
    checked.push(result);
  }
  return {entries: checked, rules};
}

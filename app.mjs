import {reconcile, statuses} from './reconcile.mjs';
import {readWorkbook} from './xlsx.mjs';
import {createResultsWorkbook} from './export.mjs';

const $ = id => document.getElementById(id);
const root = document.documentElement;
const themeToggle = $('theme-toggle');
const desktop = globalThis.chrome?.webview;
const coreRequests = new Map();
let requestId = 0;

desktop?.addEventListener('message', ({data}) => {
  if (!data?.core) return;
  if (data.id == null) {
    for (const request of coreRequests.values()) request.reject(new Error(data.error));
    coreRequests.clear();
    return;
  }
  const request = coreRequests.get(data.id);
  if (!request) return;
  coreRequests.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.data);
});

function askCore(command, details = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    coreRequests.set(id, {resolve, reject});
    try {
      desktop.postMessage({id, command, ...details});
    } catch (problem) {
      coreRequests.delete(id);
      reject(problem);
    }
  });
}

async function readFileForCore(file) {
  if (file.size > 64 * 1024 * 1024) throw new Error('Размер XLSX превышает 64 МБ.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.toBase64) return bytes.toBase64();
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 24_576) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 24_576))));
  }
  return chunks.join('');
}

function excelBlob(encoded) {
  const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(encoded)
    : Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
function applyTheme(theme) {
  root.dataset.theme = theme;
  themeToggle.setAttribute('aria-checked', String(theme === 'light'));
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).backgroundColor;
  globalThis.chrome?.webview?.postMessage(theme);
}

applyTheme(root.dataset.theme);
let requestedTheme = root.dataset.theme;
themeToggle.addEventListener('click', () => {
  const theme = requestedTheme === 'light' ? 'dark' : 'light';
  requestedTheme = theme;
  try {
    localStorage.setItem('pilot-theme', theme);
  } catch {
    // The change still applies for the current session.
  }
  const update = () => {
    if (requestedTheme === theme) applyTheme(theme);
  };
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => {
    // A second click can interrupt the animation without interrupting the theme change.
  });
});

function showStartup() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const dialog = $('startup');
  if (!dialog.showModal) return;
  const skip = $('startup-skip');
  const typed = $('startup-typed');
  const slogan = $('startup-slogan').textContent;
  const characters = Array.from(slogan, character => {
    const span = document.createElement('span');
    span.textContent = character;
    return span;
  });
  typed.replaceChildren(...characters);
  let frame;
  let finishTimer;
  let index = 0;
  let nextLetter = 540;

  function reveal() {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    cancelAnimationFrame(frame);
    characters[index - 1]?.classList.remove('caret');
    dialog.classList.add('closing');
    finishTimer = setTimeout(() => dialog.close(), 800);
  }

  let started;
  function type(now) {
    started ??= now;
    const elapsed = now - started;
    if (elapsed >= nextLetter) {
      characters[index - 1]?.classList.remove('caret');
      while (index < characters.length && elapsed >= nextLetter) {
        const letter = characters[index++];
        letter.classList.add('printed');
        nextLetter += index === characters.length ? 390
          : letter.textContent === ',' ? 105 : letter.textContent === ' ' ? 20 : 31;
      }
      if (index === characters.length && elapsed >= nextLetter) {
        reveal();
        return;
      }
      characters[index - 1]?.classList.add('caret');
    }
    frame = requestAnimationFrame(type);
  }

  const finishOnAnimation = event => {
    if (event.animationName === 'startup-backdrop-out') dialog.close();
  };
  const cancel = event => {
    event.preventDefault();
    reveal();
  };
  skip.addEventListener('click', reveal);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('animationend', finishOnAnimation);
  dialog.addEventListener('close', () => {
    cancelAnimationFrame(frame);
    clearTimeout(finishTimer);
    skip.removeEventListener('click', reveal);
    dialog.removeEventListener('cancel', cancel);
    dialog.removeEventListener('animationend', finishOnAnimation);
  }, {once: true});
  dialog.showModal();
  frame = requestAnimationFrame(type);
}

showStartup();

const format = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const amount = value => value == null ? '—' : `${format.format(value)} ₽`;
const quantity = (value, unit) => value == null ? '—' : `${format.format(value)} ${unit}`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const heading = entry => entry.looksLikeBill && entry.invoice ? `Счёт №${entry.invoice}` : `Письмо ${entry.id}`;
const supplier = entry => String(entry.sender ?? 'Поставщик не указан').split(',')[0].replace(/[«»]/g, '');
const badge = entry => `<span class="badge ${statuses[entry.status][1]}">${statuses[entry.status][0]}</span>`;
const filters = {
  all: ['Все', 'Всего писем', ''],
  attention: ['Требуют действия', 'Требуют действия', 'amber'],
  ready: ['Сверены', 'Сверены', 'green'],
  history: ['История', 'Переписка и повторы', 'muted'],
};
const groups = {
  review: 'attention', fix: 'attention', hold: 'attention', ready: 'ready',
  duplicate: 'history', replaced: 'history', info: 'history',
};
const views = {
  overview: ['Обзор сверки', 'По каким письмам нужно принять решение.'],
  queue: ['Очередь счетов', 'Найдите письмо и проверьте, как получен результат.'],
  rules: ['Правила сверки', 'Справочник из загруженной книги Excel.'],
};

let workbook;
let hasWorkbook = false;
let busy = false;
let dataset = {entries: [], rules: {}};
let added = [];
let filter = 'all';
let selected = '';
let visibleById = new Map();
let selectedRow;

function setBusy(value) {
  busy = value;
  for (const id of ['choose-file', 'replace-file', 'open-letter', 'download-results']) $(id).disabled = value;
  $('letter-form').querySelector('button[type="submit"]').disabled = value;
}

function error(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function visibleEntries() {
  const query = $('search').value.toLocaleLowerCase('ru').trim();
  return dataset.entries.filter(entry => (filter === 'all' || groups[entry.status] === filter)
    && [entry.id, entry.invoice, entry.order?.id, entry.statedOrder, entry.sender].some(field => String(field ?? '').toLocaleLowerCase('ru').includes(query)));
}

function facts(entry) {
  const order = entry.order;
  const values = [];
  if (order) {
    values.push(['Заказ в 1С', order.id], ['Сумма счёта', amount(entry.amount)]);
    values.push(['Заказано', quantity(entry.terms?.ordered ?? order.ordered, order.unit)], ['Принято на складе', quantity(order.received, order.unit)]);
    if (entry.terms) {
      values.push(['Цена по счёту', amount(entry.price)], ['Действующая цена', amount(entry.terms.price)]);
    }
  } else if (entry.amount != null) {
    values.push(['Сумма счёта', amount(entry.amount)]);
  }
  if (entry.delta != null) values.push(['Расхождение по сумме', amount(entry.delta)]);
  return values.length ? `<dl class="facts">${values.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>` : '';
}

function evidence(entry) {
  const order = entry.order;
  const orderSource = order ? `<p><strong>Заказы и приёмка · строка ${order.row}</strong><br>${escape(order.id)} · ${escape(order.material)}. Заказано ${quantity(order.ordered, order.unit)}, принято ${quantity(order.received, order.unit)}.</p>` : '';
  const changes = entry.changes.map(change => {
    const note = entry.terms?.notes.find(note => note.startsWith(change.id));
    return `<p><strong>${escape(note ?? `${change.id} · ${change.status}`)} · строка ${change.row}</strong><br>${escape(change.text)}</p>`;
  }).join('');
  const rules = entry.rules.map(rule => dataset.rules[rule]
    ? `<p><strong>${escape(rule)} · ${escape(dataset.rules[rule].title)}</strong><br>${escape(dataset.rules[rule].text)}</p>` : '').join('');
  const manual = entry.manual ?? (entry.row > workbook['Счета и письма'].length);
  const mailSource = manual ? 'Письмо введено вручную' : `Счета и письма · строка ${entry.row}`;
  return `<details><summary>Письмо, источники и правила</summary><div class="evidence">
    <blockquote><strong>${mailSource}</strong><br>${escape(entry.text)}</blockquote>${orderSource}${changes}${rules}
  </div></details>`;
}

function draft(entry) {
  if (!entry.draft) return '';
  return `<details class="draft-box"><summary>Подготовить запрос</summary><div class="evidence">
    <p><strong>Кому</strong> · ${escape(entry.recipient)}</p>
    <textarea id="draft-text" aria-label="Черновик запроса">${escape(entry.draft)}</textarea>
    <div class="draft-actions"><button class="button secondary" type="button" id="copy">Скопировать</button><span id="copy-status" role="status"></span></div>
  </div></details>`;
}

function renderDetail(entry, animate = false) {
  if (!entry) {
    $('detail').innerHTML = '<p class="empty">Выберите письмо из входящих, чтобы увидеть результат сверки.</p>';
    return;
  }
  const tone = statuses[entry.status][1];
  $('detail').innerHTML = `
    <div class="detail-head">
      <div class="detail-top"><span class="eyebrow">${escape(entry.id)}${entry.received ? ` · ${escape(entry.received)}` : ''}</span>${badge(entry)}</div>
      <h2>${escape(heading(entry))}</h2><p>${escape(supplier(entry))}</p>
    </div>
    <div class="detail-body${animate ? ' detail-enter' : ''}">
      <div class="finding ${tone}"><h3>${escape(entry.title)}</h3><p>${escape(entry.explanation)}</p></div>
      <div class="next"><span class="arrow" aria-hidden="true">→</span><div><h3>Следующий шаг</h3><p>${escape(entry.action)}</p></div></div>
      ${facts(entry)}
      ${entry.related ? `<p><button class="link" type="button" data-related="${escape(entry.related)}">Связанное письмо · ${escape(entry.related)} ↗</button></p>` : ''}
      ${draft(entry)}${evidence(entry)}
    </div>`;
}

function countResults() {
  const counts = {all: dataset.entries.length, attention: 0, ready: 0, history: 0};
  for (const entry of dataset.entries) counts[groups[entry.status]]++;
  return counts;
}

function setView(view, focusHeading = false) {
  for (const key of Object.keys(views)) {
    $('view-' + key).hidden = key !== view;
  }
  for (const button of $('workspace-nav').querySelectorAll('[data-view]')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const [title, description] = views[view];
  $('analysis-heading').textContent = title;
  $('view-description').textContent = description;
  if (focusHeading) $('analysis-heading').focus();
}

function renderOverview() {
  const counts = countResults();
  const actionable = counts.attention > 0;
  $('overview-title').textContent = actionable ? 'Требуют внимания' : 'Очередь проверена';
  $('overview-message').textContent = actionable
    ? 'Откройте спорные письма, чтобы увидеть причину и следующий шаг.'
    : 'По загруженной книге нет писем, требующих действия.';
  $('overview-number').textContent = format.format(counts.attention);
  $('overview-total').textContent = `из ${format.format(counts.all)} писем`;
  $('open-priority').textContent = actionable ? 'Открыть спорные письма' : 'Открыть очередь';
  $('open-priority').dataset.filter = actionable ? 'attention' : 'all';
  $('overview-track').innerHTML = ['attention', 'ready', 'history']
    .filter(key => counts[key] > 0)
    .map(key => `<span class="track-${key}" style="flex-grow:${counts[key]}"></span>`).join('');
  $('kpis').innerHTML = Object.entries(filters).map(([key, [, label, tone]]) =>
    `<button type="button" class="kpi" data-filter="${key}"><span class="kpi-top"><i class="dot ${tone}" aria-hidden="true"></i>${label}</span><span class="kpi-value">${format.format(counts[key])}</span></button>`).join('');

  const featured = ['hold', 'fix', 'review'].map(status =>
    dataset.entries.find(entry => entry.status === status)).filter(Boolean);
  $('priority-list').hidden = featured.length === 0;
  $('priority-entries').innerHTML = featured.map(entry => `
    <button class="priority-row" type="button" data-entry="${escape(entry.id)}">
      <span><strong>${escape(entry.id)} · ${escape(entry.title)}</strong><small>${escape(supplier(entry))}</small></span>
      ${badge(entry)}
      <span class="priority-arrow" aria-hidden="true">→</span>
    </button>`).join('');
}

function renderRules() {
  const rules = Object.entries(dataset.rules).sort(([a], [b]) => a.localeCompare(b, 'ru', {numeric: true}));
  $('rule-list').innerHTML = rules.length ? rules.map(([id, rule]) =>
    `<details class="rule"><summary><b>${escape(id)}</b> ${escape(rule.title)}</summary><p>${escape(rule.text)}</p></details>`).join('')
    : '<p class="empty">В загруженной книге нет правил для отображения.</p>';
}

function render({preserveFocus = false} = {}) {
  const rows = visibleEntries();
  visibleById = new Map(rows.map(entry => [entry.id, entry]));
  if (!visibleById.has(selected)) selected = rows[0]?.id ?? '';
  $('queue-count').textContent = `${format.format(rows.length)} из ${format.format(dataset.entries.length)} писем`;
  $('filters').innerHTML = Object.entries(filters).map(([key, [label]]) =>
    `<button type="button" class="filter" data-filter="${key}" aria-pressed="${filter === key}">${label}</button>`).join('');
  $('rows').innerHTML = rows.map(entry => `
    <tr data-id="${escape(entry.id)}" class="${entry.id === selected ? 'selected' : ''}">
      <td><button type="button" class="row-open" aria-current="${entry.id === selected}">${escape(entry.looksLikeBill && entry.invoice ? `${entry.id} · ${heading(entry)}` : heading(entry))}</button>
      <span class="row-meta">${escape(supplier(entry))}${entry.order ? ` · ${escape(entry.order.id)}` : ''}</span></td>
      <td>${badge(entry)}</td><td class="amount">${amount(entry.amount)}</td>
    </tr>`).join('');
  $('no-results').hidden = rows.length > 0;
  selectedRow = $('rows').querySelector('.selected');
  renderDetail(visibleById.get(selected));
  if (preserveFocus) selectedRow?.querySelector('.row-open').focus({preventScroll: true});
}

function setAnalysis(result, label, data) {
  if (!result.entries.length) throw new Error('В листе «Счета и письма» нет писем для сверки.');
  workbook = data;
  hasWorkbook = true;
  dataset = result;
  $('source').textContent = label;
  $('source').title = label;
  added = [];
  filter = 'all';
  selected = '';
  $('search').value = '';
  render();
  renderOverview();
  renderRules();
  $('import-start').hidden = true;
  $('analysis').hidden = false;
  setView('overview', true);
}

function openQueue(key, entryId = '') {
  filter = key;
  selected = entryId;
  $('search').value = '';
  setView('queue', !entryId);
  render({preserveFocus: Boolean(entryId)});
  if (entryId) selectedRow?.scrollIntoView({block: 'nearest'});
}

$('workspace-nav').addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (view) setView(view);
});
$('open-priority').addEventListener('click', event => openQueue(event.currentTarget.dataset.filter));
$('kpis').addEventListener('click', event => {
  const key = event.target.closest('[data-filter]')?.dataset.filter;
  if (key) openQueue(key);
});
$('priority-entries').addEventListener('click', event => {
  const id = event.target.closest('[data-entry]')?.dataset.entry;
  if (id) openQueue('attention', id);
});
$('filters').addEventListener('click', event => {
  const key = event.target.closest('[data-filter]')?.dataset.filter;
  if (!key) return;
  filter = key;
  render();
  $('filters').querySelector(`[data-filter="${key}"]`)?.focus({preventScroll: true});
});
$('search').addEventListener('input', () => render());
$('rows').addEventListener('click', event => {
  const row = event.target.closest('tr[data-id]');
  const entry = visibleById.get(row?.dataset.id);
  if (!entry) return;
  if (row !== selectedRow) {
    selectedRow?.classList.remove('selected');
    selectedRow?.querySelector('.row-open').setAttribute('aria-current', 'false');
    row.classList.add('selected');
    row.querySelector('.row-open').setAttribute('aria-current', 'true');
    selected = entry.id;
    selectedRow = row;
    renderDetail(entry, true);
  }
  if (matchMedia('(max-width: 730px)').matches) {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    $('detail').scrollIntoView({block: 'start', behavior});
  }
});
$('detail').addEventListener('click', async event => {
  const related = event.target.closest('[data-related]')?.dataset.related;
  if (related) {
    selected = related;
    filter = 'all';
    $('search').value = '';
    render({preserveFocus: true});
  }
  if (event.target.id === 'copy') {
    const field = $('draft-text');
    const label = $('copy-status');
    try {
      await navigator.clipboard.writeText(field.value);
      label.textContent = 'Скопировано';
    } catch {
      field.select();
      label.textContent = 'Текст выделен для копирования';
    }
  }
});
const upload = $('upload');
for (const id of ['choose-file', 'replace-file']) {
  $(id).addEventListener('click', () => upload.click());
}
upload.addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  upload.value = '';
  if (busy) return;
  setBusy(true);
  error();
  $('file-status').textContent = 'Проверяем данные Excel…';
  try {
    if (desktop) {
      const xlsx = await readFileForCore(file);
      const result = await askCore('load', {name: file.name, xlsx});
      setAnalysis(result.dataset, file.name);
    } else {
      const data = await readWorkbook(file);
      setAnalysis(reconcile(data), file.name, data);
    }
  } catch (problem) {
    error(`Не удалось открыть файл. ${problem.message}`);
  } finally {
    $('file-status').textContent = '';
    setBusy(false);
  }
});
$('download-results').addEventListener('click', async () => {
  if (!hasWorkbook || busy) return;
  setBusy(true);
  try {
    let file;
    if (desktop) {
      file = excelBlob(await askCore('export'));
    } else {
      const counts = countResults();
      const summary = Object.entries(filters).map(([key, [, label]]) => [label, counts[key]]);
      file = createResultsWorkbook(dataset.entries, summary, $('source').textContent);
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Результаты сверки.xlsx';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (problem) {
    error(`Не удалось скачать результаты. ${problem.message}`);
  } finally {
    setBusy(false);
  }
});
$('open-letter').addEventListener('click', () => $('letter-dialog').showModal());
$('close-letter').addEventListener('click', () => $('letter-dialog').close());
$('letter-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!hasWorkbook || busy) return;
  const form = event.target;
  const sender = $('letter-sender').value.trim();
  const body = $('letter-body').value.trim();
  if (!sender || !body) return;
  setBusy(true);
  try {
    if (desktop) {
      const result = await askCore('append', {sender, body});
      dataset = result.dataset;
      selected = result.selected;
    } else {
      let index = added.length + 1;
      while (dataset.entries.some(entry => entry.id === `Н-${index}`)) index++;
      selected = `Н-${index}`;
      const next = [...added, [selected, 'Новое письмо', sender, body]];
      dataset = reconcile(workbook, next);
      added = next;
    }
    filter = 'all';
    $('search').value = '';
    $('letter-dialog').close();
    form.reset();
    renderOverview();
    setView('queue');
    render({preserveFocus: true});
    selectedRow?.scrollIntoView({block: 'nearest'});
  } catch (problem) {
    $('letter-dialog').close();
    error(`Не удалось проверить письмо. ${problem.message}`);
  } finally {
    setBusy(false);
  }
});

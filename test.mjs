import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reconcile} from './reconcile.mjs';

const data = JSON.parse(await readFile(new URL('demo.json', import.meta.url), 'utf8'));
const {entries} = reconcile(data);
// Hand-checked against the order, warehouse and approval rows in the case workbook.
const expected = [
  ['ready', 'ЗП-10'], ['ready', 'ЗП-06'], ['replaced', 'ЗП-03'], ['ready', 'ЗП-08'],
  ['hold', 'ЗП-11'], ['ready', 'ЗП-03'], ['review', 'ЗП-01'], ['ready', 'ЗП-02'],
  ['ready', 'ЗП-12'], ['review', 'ЗП-04'], ['info', 'ЗП-04'], ['ready', 'ЗП-07'],
  ['review', 'ЗП-09'], ['duplicate', 'ЗП-06'], ['fix', 'ЗП-08'], ['hold', null],
  ['review', 'ЗП-05'], ['duplicate', 'ЗП-01'], ['info', 'ЗП-05'], ['info', 'ЗП-07'],
  ['review', 'ЗП-13'], ['duplicate', 'ЗП-12'], ['review', 'ЗП-01'], ['review', 'ЗП-14'],
  ['hold', 'ЗП-11'],
];
assert.deepEqual(entries.map(entry => [entry.status, entry.order?.id ?? null]), expected);
const find = id => entries.find(entry => entry.id === id);
assert.equal(find('В-05').related, 'В-25');
assert.equal(find('В-06').quantity, 200);
assert.equal(find('В-06').price, 180);
assert.match(find('В-07').draft, /800.*предоплат/);
assert.equal(find('В-08').terms.price, 5.5);
assert.equal(find('В-09').terms.ordered, 50);
assert.equal(find('В-10').delta, 1200);
assert.equal(find('В-12').quantity, 10000);
assert.equal(find('В-13').delta, 4500);
assert.equal(find('В-15').delta, 1000);
assert.equal(find('В-21').delta, 1600);
assert.equal(find('В-22').related, 'В-09');
assert.match(find('В-23').explanation, /20\.11/);

function newLetter(supplier, text) {
  return reconcile(data, [['Н-1', 'Новое письмо', supplier, text]]).entries.at(-1);
}
assert.equal(newLetter('Картон-Сервис', 'Счёт 98 по ЗП-14: прокладка 1200×800, 500 шт. по 12 руб. Итого 6 000 руб.').status, 'ready');
assert.equal(newLetter('Другая фирма', 'Счёт 98 по ЗП-14: прокладка 1200×800, 500 шт. по 12 руб. Итого 6 000 руб.').status, 'hold');
assert.equal(newLetter('Картон-Сервис', 'Счёт по ЗП-14: прокладка 1200×800, 500 шт. по 12 руб. Итого 6 000 руб.').status, 'review');
assert.equal(newLetter('Картон-Сервис', 'Счёт 98 по ЗП-14: прокладка 1200×1000, 500 шт. по 12 руб. Итого 6 000 руб.').status, 'review');
assert.throws(() => reconcile({}), /четыре листа/);
console.log('Проверены 25 писем из кейса, 4 новых примера и ошибка входного формата.');

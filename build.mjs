import {readFile, writeFile} from 'node:fs/promises';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const [html, css, reconcile, xlsx, exporter, app] = await Promise.all(
  ['index.html', 'style.css', 'reconcile.mjs', 'xlsx.mjs', 'export.mjs', 'app.mjs'].map(read),
);
const assets = [
  ['./assets/potok.svg', 'image/svg+xml'],
  ['./assets/navicon-dark.png', 'image/png'],
  ['./assets/navicon-light.png', 'image/png'],
];
const embeddedAssets = await Promise.all(assets.map(async ([path, type]) => {
  const contents = await readFile(new URL(path, import.meta.url));
  return [path, `data:${type};base64,${contents.toString('base64')}`];
}));
const script = [reconcile, xlsx, exporter, app].join('\n').replace(/^export /gm, '').replace(/^import .*?;\r?\n/gm, '');
const embedded = embeddedAssets.reduce((page, [path, url]) =>
  page.replaceAll(`"${path}"`, `"${url}"`), html);
const result = embedded
  .replace('<link rel="stylesheet" href="./style.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="./app.mjs"></script>', () =>
    `<script type="module">\n${script}</script>`);
await writeFile(new URL('pilot.html', import.meta.url), result);
console.log('Откройте pilot.html в Chrome или Edge.');

import {readFile, writeFile} from 'node:fs/promises';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const [html, css, reconcile, xlsx, exporter, app] = await Promise.all(
  ['index.html', 'style.css', 'reconcile.mjs', 'xlsx.mjs', 'export.mjs', 'app.mjs'].map(read),
);
const logoPaths = ['./assets/navicon-dark.png', './assets/navicon-light.png'];
const logos = await Promise.all(logoPaths.map(path => readFile(new URL(path, import.meta.url))));
const script = [reconcile, xlsx, exporter, app].join('\n').replace(/^export /gm, '').replace(/^import .*?;\r?\n/gm, '');
const embedded = logoPaths.reduce((page, path, index) =>
  page.replace(`src="${path}"`, `src="data:image/png;base64,${logos[index].toString('base64')}"`), html);
const result = embedded
  .replace('<link rel="stylesheet" href="./style.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="./app.mjs"></script>', () =>
    `<script type="module">\n${script}</script>`);
await writeFile(new URL('pilot.html', import.meta.url), result);
console.log('Откройте pilot.html в Chrome или Edge.');

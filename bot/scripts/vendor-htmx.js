import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(__dirname, '..', 'src', 'panel', 'static');

const HTMX_VERSION = '2.0.10';
const HTMX_URL = `https://unpkg.com/htmx.org@${HTMX_VERSION}/dist/htmx.min.js`;

const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function main() {
  await mkdir(STATIC, { recursive: true });

  process.stdout.write(`Скачиваю htmx ${HTMX_VERSION}... `);
  const res = await fetch(HTMX_URL);
  if (!res.ok) throw new Error(`не удалось скачать htmx: ${res.status}`);
  const code = await res.text();

  if (!code.includes('htmx')) throw new Error('скачанный файл не похож на htmx');
  await writeFile(path.join(STATIC, 'htmx.min.js'), code, 'utf8');
  console.log(`готово (${(code.length / 1024).toFixed(1)} КБ)`);

  for (const size of [192, 512]) {
    await writeFile(path.join(STATIC, `icon-${size}.png`), PLACEHOLDER_PNG);
  }
  console.log('Иконки-заглушки созданы. Замените icon-192.png и icon-512.png на логотип студии,');
  console.log('иначе на домашнем экране будет пустой квадрат.');
}

main().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});

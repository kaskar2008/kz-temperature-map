import { readFile, writeFile, mkdir, cp, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { transform } from 'esbuild';

const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
await rm(out, { recursive: true, force: true });
await mkdir(new URL('assets/', out), { recursive: true });
await cp(new URL('data/', root), new URL('data/', out), { recursive: true });
for (const name of ['favicon.png', 'favicon.ico']) await cp(new URL(name, root), new URL(name, out));
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
async function asset(name, content) {
  const [stem, ext] = name.split('.');
  if (ext === 'js' || ext === 'css') {
    const originalSize = Buffer.byteLength(content);
    ({ code: content } = await transform(content.toString(), {
      loader: ext,
      ...(ext === 'js'
        ? { format: 'esm', target: 'es2020' }
        : { target: ['chrome100', 'firefox100', 'safari15.4'] }),
      minify: true,
      charset: 'utf8',
      legalComments: 'inline',
    }));
    console.log(`${name}: ${originalSize} → ${Buffer.byteLength(content)} bytes (minified)`);
  }
  const filename = `${stem}.${hash(content)}.${ext}`;
  await writeFile(new URL(`assets/${filename}`, out), content);
  return filename;
}
const app = await asset('app.js', await readFile(new URL('assets/app.js', root), 'utf8'));
const css = await asset('app.css', await readFile(new URL('assets/app.css', root)));
const html = (await readFile(new URL('index.html', root), 'utf8'))
  .replaceAll('./assets/app.js', `./assets/${app}`).replaceAll('./assets/app.css', `./assets/${css}`);
await writeFile(new URL('index.html', out), html);
// Supported by Netlify and Cloudflare Pages. Other hosts must configure equivalent headers.
await writeFile(new URL('_headers', out), `/\n  Cache-Control: public, max-age=0, must-revalidate\n/index.html\n  Cache-Control: public, max-age=0, must-revalidate\n/data/*\n  Cache-Control: public, max-age=0, must-revalidate\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`);
let files = 0;
async function compress(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await compress(url);
    else if (/\.(html|css|js|json)$/.test(entry.name)) {
      const bytes = await readFile(url);
      // JavaScript and CSS were minified before hashing; JSON is compacted losslessly here.
      const content = entry.name.endsWith('.json') ? Buffer.from(JSON.stringify(JSON.parse(bytes))) : bytes;
      await writeFile(url, content);
      await writeFile(new URL(`${entry.name}.gz`, directory), gzipSync(content, { level: 9 }));
      await writeFile(new URL(`${entry.name}.br`, directory), brotliCompressSync(content));
      files++;
    }
  }
}
await compress(out);
console.log(`Built dist/ with hashed assets and Brotli/gzip variants for ${files} files.`);

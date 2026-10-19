/** Translation catalog checks, runnable with `node test-i18n.js`. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const extension = path.join(__dirname, 'extension');
const read = file => fs.readFileSync(path.join(extension, file), 'utf8');
const catalog = locale => JSON.parse(read(`_locales/${locale}/messages.json`));

const en = catalog('en');
const zh = catalog('zh_TW');
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'both languages define the same keys');
for (const key of Object.keys(en)) {
  assert.deepEqual(zh[key].placeholders, en[key].placeholders, `${key}: placeholders match`);
  for (const [locale, entry] of [['en', en[key]], ['zh_TW', zh[key]]]) {
    assert.ok(entry.message.trim(), `${locale}/${key} is not empty`);
    for (const name of Object.keys(entry.placeholders || {})) {
      assert.ok(entry.message.toUpperCase().includes(`$${name.toUpperCase()}$`), `${locale}/${key} uses $${name}$`);
    }
  }
}

// Every key the code asks for exists.
const sources = ['background.js', 'shared.js', 'popup.js', 'panel.js', 'popup.html', 'manifest.json'].map(f => [f, read(f)]);
const used = new Set();
for (const [, text] of sources) {
  for (const m of text.matchAll(/\b(?:t|msg)\('([A-Za-z]+)'/g)) used.add(m[1]);
  for (const m of text.matchAll(/data-i18n(?:-aria)?="([A-Za-z]+)"/g)) used.add(m[1]);
  for (const m of text.matchAll(/__MSG_([A-Za-z]+)__/g)) used.add(m[1]);
}
for (const key of used) assert.ok(en[key], `"${key}" is used but missing from the catalogs`);
for (const key of Object.keys(en)) assert.ok(used.has(key), `"${key}" is defined but never used`);
assert.equal(JSON.parse(read('manifest.json')).default_locale, 'en', 'English is the fallback language');

// No user-facing Chinese left hard-coded outside the catalogs.
for (const [file, text] of sources) {
  const line = text.split('\n').findIndex(l => /[一-鿿]/.test(l));
  assert.equal(line, -1, `${file}:${line + 1} still has hard-coded Chinese`);
}
console.log(`PASS: ${Object.keys(en).length} keys in en and zh_TW, all used keys defined, no hard-coded UI text`);

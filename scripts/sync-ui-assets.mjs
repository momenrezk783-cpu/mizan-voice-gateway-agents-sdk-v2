// Regenerate the served embedded assets from public/ so editing a dashboard actually changes production responses.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const mappings = [
  ['/', 'public/index.html', 'text/html; charset=utf-8'],
  ['/about', 'public/about.html', 'text/html; charset=utf-8'],
  ['/about.html', 'public/about.html', 'text/html; charset=utf-8'],
  ['/privacy', 'public/privacy.html', 'text/html; charset=utf-8'],
  ['/privacy.html', 'public/privacy.html', 'text/html; charset=utf-8'],
  ['/terms', 'public/terms.html', 'text/html; charset=utf-8'],
  ['/terms.html', 'public/terms.html', 'text/html; charset=utf-8'],
  ['/css/site.css', 'public/css/site.css', 'text/css; charset=utf-8'],
  ['/js/quote-form.js', 'public/js/quote-form.js', 'application/javascript; charset=utf-8'],
  ['/js/private-contact-ui.js', 'public/js/private-contact-ui.js', 'application/javascript; charset=utf-8'],
  ['/js/admin-quotes.js', 'public/js/admin-quotes.js', 'application/javascript; charset=utf-8'],
  ['/index.html', 'public/index.html', 'text/html; charset=utf-8'],
  ['/login', 'public/login.html', 'text/html; charset=utf-8'],
  ['/login.html', 'public/login.html', 'text/html; charset=utf-8'],
  ['/client', 'public/client.html', 'text/html; charset=utf-8'],
  ['/client.html', 'public/client.html', 'text/html; charset=utf-8'],
  ['/dashboard', 'public/dashboard.html', 'text/html; charset=utf-8'],
  ['/dashboard.html', 'public/dashboard.html', 'text/html; charset=utf-8'],
  ['/search', 'public/search.html', 'text/html; charset=utf-8'],
  ['/search.html', 'public/search.html', 'text/html; charset=utf-8'],
  ['/css/dashboard.css', 'public/css/dashboard.css', 'text/css; charset=utf-8'],
  ['/css/voice.css', 'public/css/voice.css', 'text/css; charset=utf-8'],
  ['/js/onboarding.js', 'public/js/onboarding.js', 'application/javascript; charset=utf-8'],
  ['/js/search-ui.js', 'public/js/search-ui.js', 'application/javascript; charset=utf-8'],
];
const assets = Object.fromEntries(mappings.map(([url, file, type]) => [url, { body: readFileSync(resolve(root, file), 'utf8'), contentType: type }]));
const result = '// Generated from public/ by npm run assets:sync. Do not edit by hand.\n' +
  'export const EMBEDDED_UI_ASSETS: Record<string, { body: string; contentType: string }> = ' + JSON.stringify(assets, null, 2) + ';\n';
const target = resolve(root, 'src/lib/ui-assets.ts');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== result) { console.error('Embedded UI assets out of sync. Run npm run assets:sync'); process.exitCode = 1; }
  else console.log('Embedded UI assets match public/.');
} else { writeFileSync(target, result); console.log('Embedded UI assets synchronized.'); }

// Final verification: how many NCs remain in "Other [Channel]" buckets
// across all 3 brands and multiple recent windows, post-final_urls-fix.
// Confirms the user's expectation that Other PMax is essentially zero.
import { initDatabase } from '../src/db/init.js';
import http from 'http';
import fs from 'fs';

const BRANDS: Array<[number, string]> = [[1, 'Little Joys'], [3, 'Man Matters'], [4, 'BeBodywise']];
const WINDOWS = [
  ['2026-06-12', '2026-06-18'],
  ['2026-06-14', '2026-06-20'],
  ['2026-05-25', '2026-06-20'],   // 27-day window for a wider sample
];

function call(path: string, cookie: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: 5011, path, headers: { cookie } }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function loginCookie(): Promise<string> {
  const env = fs.readFileSync('../.env', 'utf8');
  const u = env.match(/^ADMIN_USERNAME=(.+)$/m)?.[1];
  const p = env.match(/^ADMIN_PASSWORD=(.+)$/m)?.[1];
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'POST', hostname: 'localhost', port: 5011, path: '/api/auth/login',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c);
      res.on('end', () => resolve((res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')));
    }); req.on('error', reject); req.write(JSON.stringify({ username: u, password: p })); req.end();
  });
}

(async () => {
  initDatabase();
  const cookie = await loginCookie();
  console.log(`\nVerification: "Other [Channel]" NCs across brands × windows after final_urls map fix\n`);
  console.log(`  ${'Brand'.padEnd(14)} ${'Window'.padEnd(24)} ${'Total NCs'.padStart(10)} ${'Real NCs'.padStart(10)} ${'Other PMax'.padStart(12)} ${'Other Search'.padStart(13)} ${'Other Shop'.padStart(12)} ${'Other (other)'.padStart(14)} ${'%Other'.padStart(8)}`);
  console.log('  ' + '─'.repeat(120));

  for (const [bid, brand] of BRANDS) {
    for (const [from, to] of WINDOWS) {
      const res = await call(`/api/campaigns?brand_id=${bid}&from=${from}&to=${to}`, cookie) as { rows: Array<any> };
      let real = 0, oPmax = 0, oSearch = 0, oShop = 0, oOther = 0;
      const samples: { [k: string]: string[] } = {};
      for (const r of res.rows) {
        const m = r.metrics || {};
        if (r.synthetic) {
          const ch = r.channel_type;
          if (ch === 'PERFORMANCE_MAX') { oPmax += m.ncs || 0; samples['pmax'] = (samples['pmax'] || []).concat(r.synthetic_samples || []); }
          else if (ch === 'SEARCH') { oSearch += m.ncs || 0; samples['search'] = (samples['search'] || []).concat(r.synthetic_samples || []); }
          else if (ch === 'SHOPPING') { oShop += m.ncs || 0; samples['shop'] = (samples['shop'] || []).concat(r.synthetic_samples || []); }
          else { oOther += m.ncs || 0; samples['other'] = (samples['other'] || []).concat(r.synthetic_samples || []); }
        } else if (r.campaign_id) {
          real += m.ncs || 0;
        }
      }
      const total = real + oPmax + oSearch + oShop + oOther;
      const pct = total > 0 ? ((oPmax + oSearch + oShop + oOther) / total) * 100 : 0;
      console.log(`  ${brand.padEnd(14)} ${(from + '..' + to).padEnd(24)} ${Math.round(total).toString().padStart(10)} ${Math.round(real).toString().padStart(10)} ${Math.round(oPmax).toString().padStart(12)} ${Math.round(oSearch).toString().padStart(13)} ${Math.round(oShop).toString().padStart(12)} ${Math.round(oOther).toString().padStart(14)} ${pct.toFixed(2).padStart(7)}%`);
      // If any Other bucket has >0 NCs, dump samples for inspection
      if (oPmax + oSearch + oShop + oOther > 5) {
        for (const [k, v] of Object.entries(samples)) {
          if (v.length) console.log(`      ${k} samples: ${[...new Set(v)].slice(0, 6).join(' | ')}`);
        }
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

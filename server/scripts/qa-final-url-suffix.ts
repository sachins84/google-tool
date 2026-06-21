// Pull campaign.final_url_suffix for every LJ PMax campaign so we can see
// EXACTLY which utm_campaign values Google bakes into every click URL for
// each campaign. This is the authoritative source for "which utm_campaign
// string maps to which campaign_id" — better than fuzzy asset-group matching.
import { initDatabase } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

interface Row {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string; finalUrlSuffix?: string };
}

/** Extract every utm_campaign=X value from a Final URL Suffix string. */
function extractUtmCampaigns(suffix: string | undefined): string[] {
  if (!suffix) return [];
  let s = suffix;
  try { s = decodeURIComponent(suffix); } catch { /* keep */ }
  const out: string[] = [];
  const re = /(?:^|&|\?)utm_campaign=([^&#]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

(async () => {
  initDatabase();
  for (const brandId of [1, 3, 4]) {
    const brand = getBrand(brandId);
    if (!brand) continue;
    console.log(`\n════════════ ${brand.name} (brand ${brandId}) — PMax final_url_suffix ════════════`);

    // Pull all PMax campaigns (not just ENABLED — we want to see the suffix even for paused ones)
    let allRows: Row[] = [];
    for (const acc of brand.accounts) {
      try {
        const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
        const rows = await search<Row>({
          customerId: acc.customer_id, loginCustomerId,
          query: `SELECT campaign.id, campaign.name, campaign.status,
                         campaign.advertising_channel_type, campaign.final_url_suffix
                  FROM campaign
                  WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
                    AND campaign.status != 'REMOVED'`,
        });
        allRows = allRows.concat(rows);
      } catch (e) {
        console.error(`  account ${acc.customer_id}:`, e instanceof Error ? e.message : String(e));
      }
    }

    // Group by suffix content to see how many campaigns share each pattern
    const byPattern = new Map<string, Row[]>();
    for (const r of allRows) {
      const key = r.campaign?.finalUrlSuffix ?? '(empty)';
      const list = byPattern.get(key) ?? [];
      list.push(r); byPattern.set(key, list);
    }

    console.log(`  Total PMax campaigns: ${allRows.length}`);
    console.log(`  Distinct final_url_suffix patterns: ${byPattern.size}`);
    console.log();

    // Sort by group size descending; show top 8 patterns
    const sorted = [...byPattern.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [pattern, group] of sorted.slice(0, 8)) {
      const utms = extractUtmCampaigns(pattern);
      console.log(`  ┌─ Pattern (${group.length} campaign(s) share this):`);
      console.log(`  │  suffix: ${pattern.length > 200 ? pattern.slice(0, 200) + '…' : pattern}`);
      console.log(`  │  utm_campaign values extracted: [${utms.join(', ')}]`);
      console.log(`  │  campaigns using this:`);
      for (const r of group.slice(0, 8)) {
        console.log(`  │    ${(r.campaign?.name ?? '?').slice(0, 50).padEnd(50)} id=${r.campaign?.id ?? '?'}  status=${r.campaign?.status ?? '?'}`);
      }
      if (group.length > 8) console.log(`  │    … and ${group.length - 8} more`);
      console.log();
    }

    // Now: for each campaign, build a candidate map: utm_campaign-extracted-value → campaign_id
    // Specifically, the FIRST utm_campaign in the suffix (which PHP's parser tends to pick).
    const firstUtmToCampaign = new Map<string, string[]>();   // first-position value → [campaign_id]
    const anyUtmToCampaign = new Map<string, string[]>();      // any-position value → [campaign_id]
    for (const r of allRows) {
      const id = r.campaign?.id; if (!id) continue;
      const utms = extractUtmCampaigns(r.campaign?.finalUrlSuffix);
      if (!utms.length) continue;
      const first = utms[0];
      if (first) {
        const list = firstUtmToCampaign.get(first) ?? [];
        if (!list.includes(id)) list.push(id);
        firstUtmToCampaign.set(first, list);
      }
      for (const v of utms) {
        const list = anyUtmToCampaign.get(v) ?? [];
        if (!list.includes(id)) list.push(id);
        anyUtmToCampaign.set(v, list);
      }
    }

    console.log(`  ── Map: first-position utm_campaign in final_url_suffix → campaign(s) ──`);
    console.log(`     (these are the values Magento's first-wins parser would write)`);
    const first = [...firstUtmToCampaign.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [val, cids] of first.slice(0, 25)) {
      const names = cids.map((c) => allRows.find((r) => r.campaign?.id === c)?.campaign?.name ?? c).slice(0, 4);
      const status = cids.map((c) => allRows.find((r) => r.campaign?.id === c)?.campaign?.status ?? '?').slice(0, 4);
      console.log(`     "${val.padEnd(28)}"  → ${cids.length} campaign(s):  ${names.map((n, i) => `${(n || '').slice(0, 28)}[${status[i]?.[0] ?? '?'}]`).join('  |  ')}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

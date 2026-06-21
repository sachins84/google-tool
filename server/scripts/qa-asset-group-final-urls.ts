// Build the authoritative map: utm_campaign value → campaign_id by extracting
// utm_campaign=X from every PMax asset_group's final_urls. This is Google's
// own record of "what utm_campaign string ends up in URLs for this campaign",
// independent of Magento's parser behavior.
import { initDatabase } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

function extractUtmCampaigns(url: string | undefined): string[] {
  if (!url) return [];
  let s = url;
  try { s = decodeURIComponent(url); } catch { /* */ }
  const out: string[] = [];
  const re = /[?&]utm_campaign=([^&#]+)/g;
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
    console.log(`\n══════════════ ${brand.name} ══════════════`);

    interface AGRow {
      assetGroup?: { id?: string; name?: string; status?: string; finalUrls?: string[] };
      campaign?: { id?: string; name?: string; status?: string };
    }
    let all: AGRow[] = [];
    for (const acc of brand.accounts) {
      try {
        const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
        const rows = await search<AGRow>({
          customerId: acc.customer_id, loginCustomerId,
          query: `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.final_urls,
                         campaign.id, campaign.name, campaign.status
                  FROM asset_group
                  WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
                    AND campaign.status != 'REMOVED'`,
        });
        all = all.concat(rows);
      } catch (e) {
        console.error(`  account ${acc.customer_id} error:`, e instanceof Error ? e.message : String(e));
      }
    }

    console.log(`  Total PMax asset_groups: ${all.length}`);
    let withFinalUrls = 0, withUtmInFinalUrls = 0;
    const utmToCampaigns = new Map<string, Set<string>>();
    const utmToCampaignNames = new Map<string, Set<string>>();
    for (const r of all) {
      const ag = r.assetGroup!; const camp = r.campaign!;
      const cid = camp.id; if (!cid) continue;
      const finalUrls = ag.finalUrls ?? [];
      if (finalUrls.length) withFinalUrls++;
      const utmsAll = new Set<string>();
      for (const u of finalUrls) for (const v of extractUtmCampaigns(u)) utmsAll.add(v);
      if (utmsAll.size) withUtmInFinalUrls++;
      for (const utm of utmsAll) {
        const lc = utm.toLowerCase();
        let s = utmToCampaigns.get(lc); if (!s) { s = new Set(); utmToCampaigns.set(lc, s); }
        s.add(cid);
        let sn = utmToCampaignNames.get(lc); if (!sn) { sn = new Set(); utmToCampaignNames.set(lc, sn); }
        sn.add(camp.name ?? cid);
      }
    }
    console.log(`  Asset-groups with final_urls populated:                ${withFinalUrls} / ${all.length}`);
    console.log(`  Asset-groups with utm_campaign in final_urls:          ${withUtmInFinalUrls}`);
    console.log(`  Distinct utm_campaign values found in final_urls:      ${utmToCampaigns.size}`);
    console.log();

    // Show top utm_campaign → campaign(s) mappings, prioritizing ambiguous ones (multiple campaigns)
    const sorted = [...utmToCampaigns.entries()].sort((a, b) => b[1].size - a[1].size);
    console.log(`  Top 30 utm_campaign values → campaign_id(s):`);
    for (const [utm, cids] of sorted.slice(0, 30)) {
      const names = [...(utmToCampaignNames.get(utm) ?? new Set())].slice(0, 4);
      const ids = [...cids].slice(0, 4);
      const tag = cids.size === 1 ? '✓ unique' : `✗ ${cids.size}-way ambiguous`;
      console.log(`    "${utm.padEnd(28)}"  ${tag}  ${ids.join(', ')}  ${names.join(' | ').slice(0, 80)}`);
    }

    // Check specifically: does "calcium_gummies" appear?
    const cgKey = 'calcium_gummies';
    if (utmToCampaigns.has(cgKey)) {
      console.log(`\n  ✓ '${cgKey}' resolves to ${utmToCampaigns.get(cgKey)!.size} campaign(s):`);
      for (const cid of utmToCampaigns.get(cgKey)!) {
        const name = all.find((r) => r.campaign?.id === cid)?.campaign?.name ?? '?';
        console.log(`     ${cid}  ${name}`);
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

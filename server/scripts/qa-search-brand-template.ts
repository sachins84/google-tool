// For MM Search campaigns Search_Brand (ENABLED, 22580437328) and
// Search_Brand_MM (PAUSED, 9250997199), pull every URL-related field that
// could inject `utm_campaign=Search_Brand_MM` into click URLs.
import { initDatabase } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

const ACTIVE = '22580437328';     // Search_Brand
const PAUSED = '9250997199';      // Search_Brand_MM

(async () => {
  initDatabase();
  const brand = getBrand(3);
  if (!brand) return;

  for (const acc of brand.accounts) {
    const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
    try {
      const camps = await search<{ campaign?: { id?: string; name?: string; status?: string; finalUrlSuffix?: string; trackingUrlTemplate?: string; urlCustomParameters?: Array<{ key?: string; value?: string }> } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status, campaign.final_url_suffix, campaign.tracking_url_template, campaign.url_custom_parameters
                FROM campaign WHERE campaign.id IN (${ACTIVE}, ${PAUSED})`,
      });
      if (!camps.length) continue;
      console.log(`══════════════ Account ${acc.customer_id} ══════════════\n`);
      for (const r of camps) {
        const c = r.campaign!;
        console.log(`  ── Campaign ${c.id} (${c.name}, ${c.status}) ──`);
        console.log(`     campaign.tracking_url_template: ${c.trackingUrlTemplate || '(empty)'}`);
        console.log(`     campaign.final_url_suffix:      ${c.finalUrlSuffix || '(empty)'}`);
        console.log(`     campaign.url_custom_parameters: ${JSON.stringify(c.urlCustomParameters ?? [])}`);
        console.log();
      }
      // Account-level template
      const cust = await search<{ customer?: { id?: string; finalUrlSuffix?: string; trackingUrlTemplate?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT customer.id, customer.final_url_suffix, customer.tracking_url_template FROM customer LIMIT 1`,
      });
      if (cust[0]?.customer) {
        const cu = cust[0].customer;
        console.log(`  Account-level (customer ${cu.id}):`);
        console.log(`     customer.tracking_url_template: ${cu.trackingUrlTemplate || '(empty)'}`);
        console.log(`     customer.final_url_suffix:      ${cu.finalUrlSuffix || '(empty)'}`);
        console.log();
      }
      // Pull ad-level final_urls and tracking templates for active Search_Brand
      const ads = await search<{ campaign?: { id?: string }; adGroupAd?: { ad?: { id?: string; finalUrls?: string[] }; status?: string }; adGroup?: { name?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group.name
                FROM ad_group_ad
                WHERE campaign.id = ${ACTIVE}
                  AND ad_group_ad.status != 'REMOVED'`,
      });
      console.log(`  Active Search_Brand ad-level final URLs (first 5 ENABLED ads):`);
      let shown = 0;
      for (const r of ads) {
        if (r.adGroupAd?.status !== 'ENABLED' || shown >= 5) continue;
        const urls = r.adGroupAd?.ad?.finalUrls ?? [];
        console.log(`    ad ${r.adGroupAd?.ad?.id} (ad_group="${r.adGroup?.name}"):`);
        for (const u of urls.slice(0, 2)) console.log(`      ${u}`);
        shown++;
      }
      // Ad group-level templates for active Search_Brand
      const groups = await search<{ campaign?: { id?: string }; adGroup?: { id?: string; name?: string; status?: string; trackingUrlTemplate?: string; finalUrlSuffix?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.tracking_url_template, ad_group.final_url_suffix
                FROM ad_group WHERE campaign.id = ${ACTIVE}`,
      });
      console.log(`\n  Active Search_Brand ad_group-level templates (first 5):`);
      for (const r of groups.slice(0, 5)) {
        const g = r.adGroup!;
        console.log(`    ad_group "${g.name}" (${g.status}):`);
        console.log(`      tracking_url_template: ${g.trackingUrlTemplate || '(inherit)'}`);
        console.log(`      final_url_suffix:      ${g.finalUrlSuffix || '(inherit)'}`);
      }
      process.exit(0);
    } catch (e) {
      // Try next account
    }
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });

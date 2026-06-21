// Drill into the exact campaign in the user's URL (PMax_Brain and Calcium Gummies-02,
// id 23847924713). Pull every URL-template / suffix / asset_group field to find
// where `utm_campaign=Calcium_Gummies` is being injected.
import { initDatabase } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

const TARGET = '23847924713';

(async () => {
  initDatabase();
  const brand = getBrand(1);
  if (!brand) return;

  for (const acc of brand.accounts) {
    const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;

    // (1) The campaign itself — every URL-related field GAQL exposes
    try {
      const camp = await search<{
        campaign?: {
          id?: string; name?: string; status?: string;
          finalUrlSuffix?: string;
          trackingUrlTemplate?: string;
          urlCustomParameters?: Array<{ key?: string; value?: string }>;
        };
      }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status,
                       campaign.final_url_suffix, campaign.tracking_url_template,
                       campaign.url_custom_parameters
                FROM campaign
                WHERE campaign.id = ${TARGET}`,
      });
      if (camp.length) {
        console.log(`══════════════ Campaign ${TARGET} (account ${acc.customer_id}) ══════════════`);
        const c = camp[0].campaign!;
        console.log(`  name:                 ${c.name}`);
        console.log(`  status:               ${c.status}`);
        console.log(`  final_url_suffix:     ${c.finalUrlSuffix ?? '(empty)'}`);
        console.log(`  tracking_url_template: ${c.trackingUrlTemplate ?? '(empty)'}`);
        console.log(`  url_custom_parameters: ${JSON.stringify(c.urlCustomParameters ?? [])}`);

        // (2) Asset-group fields for this campaign
        const ags = await search<{
          assetGroup?: { id?: string; name?: string; status?: string; finalUrls?: string[]; finalMobileUrls?: string[]; trackingUrlTemplate?: string; path1?: string; path2?: string };
        }>({
          customerId: acc.customer_id, loginCustomerId,
          query: `SELECT asset_group.id, asset_group.name, asset_group.status,
                         asset_group.final_urls, asset_group.tracking_url_template,
                         asset_group.path1, asset_group.path2
                  FROM asset_group
                  WHERE asset_group.campaign = 'customers/${acc.customer_id}/campaigns/${TARGET}'`,
        });
        console.log(`\n  Asset groups in this campaign (${ags.length}):`);
        for (const a of ags) {
          const ag = a.assetGroup!;
          console.log(`    ─ ${ag.name?.padEnd(40)} id=${ag.id}  status=${ag.status}`);
          console.log(`      final_urls:            ${(ag.finalUrls ?? []).slice(0, 2).join(' | ') || '(none)'}`);
          console.log(`      tracking_url_template: ${ag.trackingUrlTemplate ?? '(empty)'}`);
          if (ag.path1 || ag.path2) console.log(`      path1=${ag.path1 ?? ''}  path2=${ag.path2 ?? ''}`);
        }

        // (3) Account-level URL settings — does the customer have global suffix?
        const cust = await search<{ customer?: { id?: string; finalUrlSuffix?: string; trackingUrlTemplate?: string } }>({
          customerId: acc.customer_id, loginCustomerId,
          query: `SELECT customer.id, customer.final_url_suffix, customer.tracking_url_template
                  FROM customer LIMIT 1`,
        });
        if (cust.length) {
          const cu = cust[0].customer!;
          console.log(`\n  Account-level (customer ${cu.id}):`);
          console.log(`    final_url_suffix:      ${cu.finalUrlSuffix ?? '(empty)'}`);
          console.log(`    tracking_url_template: ${cu.trackingUrlTemplate ?? '(empty)'}`);
        }

        // Stop once we find the campaign
        process.exit(0);
      }
    } catch (e) {
      console.error(`  account ${acc.customer_id} error:`, e instanceof Error ? e.message : String(e));
    }
  }
  console.log(`Campaign ${TARGET} not found in any LJ account.`);
  process.exit(1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

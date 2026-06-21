// Pull Google Ads landing_page_view for Search_Brand to see ACTUAL destination
// URLs Google generated for clicks on this campaign. If any of those URLs
// contain `utm_campaign=Search_Brand_MM`, that proves the user's hypothesis
// that Search_Brand is somehow firing that UTM. If none do, then those NCs
// are coming from a non-Google source.
import { initDatabase } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

const ACTIVE = '22580437328';   // Search_Brand
const PAUSED = '9250997199';    // Search_Brand_MM

(async () => {
  initDatabase();
  const brand = getBrand(3);
  if (!brand) return;

  for (const acc of brand.accounts) {
    const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
    try {
      // Try landing_page_view (newer GAQL resource)
      const lpvActive = await search<{ landingPageView?: { unexpandedFinalUrl?: string }; metrics?: { impressions?: string; clicks?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, landing_page_view.unexpanded_final_url, metrics.impressions, metrics.clicks
                FROM landing_page_view
                WHERE segments.date BETWEEN '2026-06-12' AND '2026-06-20'
                  AND campaign.id = ${ACTIVE}`,
      });
      if (lpvActive.length) {
        console.log(`\n══════════════ Search_Brand (${ACTIVE}) — landing_page_view (un-expanded URLs) ══════════════`);
        let containsMM = 0, total = 0;
        const urlSamples = new Set<string>();
        for (const r of lpvActive) {
          const u = r.landingPageView?.unexpandedFinalUrl ?? '';
          const impr = Number(r.metrics?.impressions ?? 0);
          total += impr;
          if (u.toLowerCase().includes('search_brand_mm')) containsMM += impr;
          urlSamples.add(u);
        }
        console.log(`  Total impressions over window: ${total}`);
        console.log(`  Impressions on URLs containing 'search_brand_mm': ${containsMM}`);
        console.log(`  Distinct landing-page URLs Google generated for Search_Brand:`);
        for (const u of [...urlSamples].slice(0, 12)) console.log(`    ${u.length > 200 ? u.slice(0, 200) + '…' : u}`);
        return process.exit(0);
      }
    } catch (e) {
      console.error(`  account ${acc.customer_id}:`, e instanceof Error ? e.message : String(e));
    }
  }
  process.exit(1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

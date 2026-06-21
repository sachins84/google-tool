// Find where `utm_campaign=Search_Brand_MM` is being injected into MM URLs.
// Scan ALL MM Search campaigns' templates, ad final_urls, ad_group_criterion
// final_urls (keywords), and final_url_suffix values for that literal.
import { initDatabase } from '../src/db/init.js';
import { getBrand } from '../src/services/brands.js';
import { search } from '../src/services/google-ads.js';
import { getLoginCustomerId } from '../src/services/mcc-map.js';

const HUNT = 'search_brand_mm';

function hits(s: string | undefined): boolean { return !!s && s.toLowerCase().includes(HUNT); }

(async () => {
  initDatabase();
  const brand = getBrand(3);
  if (!brand) return;
  let found = 0;
  for (const acc of brand.accounts) {
    const loginCustomerId = (await getLoginCustomerId(acc.customer_id)) ?? undefined;
    console.log(`\n══════════════ Account ${acc.customer_id} ══════════════`);

    // 1) Campaign-level: tracking_url_template OR final_url_suffix
    try {
      const camps = await search<{ campaign?: { id?: string; name?: string; status?: string; finalUrlSuffix?: string; trackingUrlTemplate?: string; advertisingChannelType?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                       campaign.final_url_suffix, campaign.tracking_url_template
                FROM campaign WHERE campaign.status != 'REMOVED'`,
      });
      for (const r of camps) {
        const c = r.campaign!;
        if (hits(c.finalUrlSuffix) || hits(c.trackingUrlTemplate)) {
          found++;
          console.log(`  CAMPAIGN match: ${c.id} ${c.name} (${c.status}, ${c.advertisingChannelType})`);
          if (hits(c.trackingUrlTemplate)) console.log(`    tracking_url_template: ${c.trackingUrlTemplate}`);
          if (hits(c.finalUrlSuffix)) console.log(`    final_url_suffix:      ${c.finalUrlSuffix}`);
        }
      }
    } catch (e) { /* */ }

    // 2) Ad-level: ad_group_ad.ad.final_urls + ad_group_ad.ad.tracking_url_template
    try {
      const ads = await search<{ campaign?: { id?: string; name?: string; status?: string }; adGroup?: { id?: string; name?: string }; adGroupAd?: { ad?: { id?: string; finalUrls?: string[]; trackingUrlTemplate?: string }; status?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, campaign.status,
                       ad_group.id, ad_group.name,
                       ad_group_ad.ad.id, ad_group_ad.ad.final_urls,
                       ad_group_ad.ad.tracking_url_template, ad_group_ad.status
                FROM ad_group_ad
                WHERE ad_group_ad.status != 'REMOVED'`,
      });
      for (const r of ads) {
        const finalUrls = r.adGroupAd?.ad?.finalUrls ?? [];
        const tmpl = r.adGroupAd?.ad?.trackingUrlTemplate;
        const matched = finalUrls.some(hits) || hits(tmpl);
        if (matched) {
          found++;
          console.log(`  AD match: campaign ${r.campaign?.id} ${r.campaign?.name} (${r.campaign?.status}) · ad_group ${r.adGroup?.name} · ad ${r.adGroupAd?.ad?.id} (${r.adGroupAd?.status})`);
          for (const u of finalUrls) if (hits(u)) console.log(`    final_url: ${u}`);
          if (hits(tmpl)) console.log(`    tracking_url_template: ${tmpl}`);
        }
      }
    } catch (e) { /* */ }

    // 3) Ad-group-level templates
    try {
      const groups = await search<{ campaign?: { id?: string; name?: string }; adGroup?: { id?: string; name?: string; trackingUrlTemplate?: string; finalUrlSuffix?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
                       ad_group.tracking_url_template, ad_group.final_url_suffix
                FROM ad_group WHERE ad_group.status != 'REMOVED'`,
      });
      for (const r of groups) {
        const g = r.adGroup!;
        if (hits(g.trackingUrlTemplate) || hits(g.finalUrlSuffix)) {
          found++;
          console.log(`  AD_GROUP match: campaign ${r.campaign?.id} ${r.campaign?.name} · ad_group ${g.name}`);
          if (hits(g.trackingUrlTemplate)) console.log(`    tracking_url_template: ${g.trackingUrlTemplate}`);
          if (hits(g.finalUrlSuffix)) console.log(`    final_url_suffix:      ${g.finalUrlSuffix}`);
        }
      }
    } catch (e) { /* */ }

    // 4) Keyword-level: ad_group_criterion.final_urls + tracking_url_template
    try {
      const kws = await search<{ campaign?: { id?: string; name?: string }; adGroup?: { name?: string }; adGroupCriterion?: { criterionId?: string; finalUrls?: string[]; trackingUrlTemplate?: string; keyword?: { text?: string }; type?: string; status?: string } }>({
        customerId: acc.customer_id, loginCustomerId,
        query: `SELECT campaign.id, campaign.name, ad_group.name,
                       ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                       ad_group_criterion.final_urls, ad_group_criterion.tracking_url_template,
                       ad_group_criterion.type, ad_group_criterion.status
                FROM ad_group_criterion
                WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`,
      });
      for (const r of kws) {
        const k = r.adGroupCriterion!;
        const urls = k.finalUrls ?? [];
        if (urls.some(hits) || hits(k.trackingUrlTemplate)) {
          found++;
          console.log(`  KEYWORD match: campaign ${r.campaign?.id} ${r.campaign?.name} · ad_group ${r.adGroup?.name} · kw "${k.keyword?.text}"`);
          for (const u of urls) if (hits(u)) console.log(`    final_url: ${u}`);
          if (hits(k.trackingUrlTemplate)) console.log(`    tracking_url_template: ${k.trackingUrlTemplate}`);
        }
      }
    } catch (e) { /* */ }
  }
  console.log(`\nTotal matches for "${HUNT}": ${found}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

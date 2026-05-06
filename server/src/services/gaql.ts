/**
 * GAQL query builders for Google Ads API v21.
 * One source of truth for queries used by routes/campaigns, ad-groups, ads.
 */

export type Level = 'campaign' | 'ad_group' | 'ad' | 'keyword' | 'search_term' | 'asset';

interface BuildOptions {
  level: Level;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  campaignIds?: string[];
  adGroupIds?: string[];
}

const METRIC_FIELDS = [
  'metrics.cost_micros',
  'metrics.impressions',
  'metrics.clicks',
  'metrics.conversions',
  'metrics.conversions_value',
  'metrics.view_through_conversions',
];

function dateClause(from: string, to: string): string {
  return `segments.date BETWEEN '${from}' AND '${to}'`;
}

function inClause(ids: string[]): string {
  return `(${ids.map((id) => `'${id}'`).join(', ')})`;
}

export function buildCampaignsQuery(opts: BuildOptions): string {
  const fields = [
    'campaign.id',
    'campaign.name',
    'campaign.status',
    'campaign.advertising_channel_type',
    'campaign.bidding_strategy_type',
    'campaign_budget.amount_micros',
    ...METRIC_FIELDS,
  ];
  const where = [dateClause(opts.from, opts.to), `campaign.status != 'REMOVED'`];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM campaign
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildAdGroupsQuery(opts: BuildOptions): string {
  const fields = [
    'campaign.id',
    'campaign.name',
    'ad_group.id',
    'ad_group.name',
    'ad_group.status',
    'ad_group.type',
    'ad_group.cpc_bid_micros',
    ...METRIC_FIELDS,
  ];
  const where = [dateClause(opts.from, opts.to), `ad_group.status != 'REMOVED'`];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  if (opts.adGroupIds?.length) where.push(`ad_group.id IN ${inClause(opts.adGroupIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM ad_group
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildAdsQuery(opts: BuildOptions): string {
  const fields = [
    'campaign.id',
    'campaign.name',
    'ad_group.id',
    'ad_group.name',
    'ad_group_ad.ad.id',
    'ad_group_ad.ad.name',
    'ad_group_ad.ad.type',
    'ad_group_ad.status',
    'ad_group_ad.ad.responsive_search_ad.headlines',
    'ad_group_ad.ad.responsive_search_ad.descriptions',
    'ad_group_ad.ad.final_urls',
    ...METRIC_FIELDS,
  ];
  const where = [dateClause(opts.from, opts.to), `ad_group_ad.status != 'REMOVED'`];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  if (opts.adGroupIds?.length) where.push(`ad_group.id IN ${inClause(opts.adGroupIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM ad_group_ad
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildKeywordsQuery(opts: BuildOptions): string {
  const fields = [
    'campaign.id',
    'campaign.name',
    'ad_group.id',
    'ad_group.name',
    'ad_group_criterion.criterion_id',
    'ad_group_criterion.keyword.text',
    'ad_group_criterion.keyword.match_type',
    'ad_group_criterion.status',
    'ad_group_criterion.quality_info.quality_score',
    ...METRIC_FIELDS,
  ];
  const where = [
    dateClause(opts.from, opts.to),
    `ad_group_criterion.type = 'KEYWORD'`,
    `ad_group_criterion.status != 'REMOVED'`,
  ];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  if (opts.adGroupIds?.length) where.push(`ad_group.id IN ${inClause(opts.adGroupIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM keyword_view
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildSearchTermsQuery(opts: BuildOptions): string {
  const fields = [
    'campaign.id',
    'campaign.name',
    'ad_group.id',
    'ad_group.name',
    'search_term_view.search_term',
    'search_term_view.status',
    'segments.search_term_match_type',
    ...METRIC_FIELDS,
  ];
  const where = [dateClause(opts.from, opts.to)];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  if (opts.adGroupIds?.length) where.push(`ad_group.id IN ${inClause(opts.adGroupIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM search_term_view
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildAssetsQuery(opts: BuildOptions): string {
  // PMax assets: asset_group_asset_view returns assets within asset groups with performance labels.
  // Note: metrics on this view are limited at the asset level — returning structural fields only here.
  const fields = [
    'campaign.id',
    'campaign.name',
    'asset_group.id',
    'asset_group.name',
    'asset_group_asset.field_type',
    'asset_group_asset.performance_label',
    'asset.id',
    'asset.type',
    'asset.text_asset.text',
    'asset.image_asset.full_size.url',
    'asset.youtube_video_asset.youtube_video_id',
  ];
  const where: string[] = [];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return `
    SELECT ${fields.join(', ')}
    FROM asset_group_asset
    ${whereClause}
  `.trim();
}

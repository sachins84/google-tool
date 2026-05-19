/**
 * GAQL query builders for Google Ads API v21.
 * One source of truth for queries used by routes/campaigns, ad-groups, ads.
 */

export type Level = 'campaign' | 'ad_group' | 'asset_group' | 'ad' | 'keyword' | 'search_term' | 'asset' | 'audience' | 'product' | 'video_asset';

interface BuildOptions {
  level: Level;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  campaignIds?: string[];
  adGroupIds?: string[];
  assetGroupIds?: string[];
}

const METRIC_FIELDS = [
  'metrics.cost_micros',
  'metrics.impressions',
  'metrics.clicks',
  'metrics.conversions',
  'metrics.conversions_value',
  'metrics.view_through_conversions',
  'metrics.all_conversions',
  'metrics.all_conversions_value',
  'metrics.cross_device_conversions',
  'metrics.absolute_top_impression_percentage',
  'metrics.top_impression_percentage',
  'metrics.engagements',
  'metrics.engagement_rate',
  'metrics.video_views',
  'metrics.average_cpv',
];

// Subset of METRIC_FIELDS that asset_group / asset_group_asset accept
// (most percentage/engagement fields error on those views).
const NARROW_METRIC_FIELDS = [
  'metrics.cost_micros',
  'metrics.impressions',
  'metrics.clicks',
  'metrics.conversions',
  'metrics.conversions_value',
  'metrics.view_through_conversions',
  'metrics.all_conversions',
  'metrics.all_conversions_value',
  'metrics.cross_device_conversions',
];

// Impression-share fields are Search/Shopping only and apply at campaign/ad_group/keyword level.
const SEARCH_IS_FIELDS_CAMPAIGN = [
  'metrics.search_impression_share',
  'metrics.search_top_impression_share',
  'metrics.search_absolute_top_impression_share',
  'metrics.search_budget_lost_impression_share',
  'metrics.search_rank_lost_impression_share',
];

const SEARCH_IS_FIELDS_AD_GROUP = [
  'metrics.search_impression_share',
  'metrics.search_top_impression_share',
  'metrics.search_absolute_top_impression_share',
  'metrics.search_rank_lost_impression_share',
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
    ...SEARCH_IS_FIELDS_CAMPAIGN,
  ];
  const where = [dateClause(opts.from, opts.to), `campaign.status != 'REMOVED'`];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM campaign
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildAssetGroupsQuery(opts: BuildOptions): string {
  // PMax-only. Returns asset_group rows with date-segmented metrics + ad_strength + URL parts.
  const fields = [
    'campaign.id',
    'campaign.name',
    'campaign.advertising_channel_type',
    'asset_group.id',
    'asset_group.name',
    'asset_group.status',
    'asset_group.ad_strength',
    'asset_group.final_urls',
    'asset_group.path1',
    'asset_group.path2',
    ...NARROW_METRIC_FIELDS,
  ];
  const where = [dateClause(opts.from, opts.to), `asset_group.status != 'REMOVED'`];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  if (opts.assetGroupIds?.length) where.push(`asset_group.id IN ${inClause(opts.assetGroupIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM asset_group
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
    'ad_group.target_cpa_micros',
    'ad_group.target_roas',
    ...METRIC_FIELDS,
    ...SEARCH_IS_FIELDS_AD_GROUP,
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
    'ad_group_ad.ad.app_ad.headlines',
    'ad_group_ad.ad.app_ad.descriptions',
    'ad_group_ad.ad.responsive_display_ad.headlines',
    'ad_group_ad.ad.responsive_display_ad.descriptions',
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
    ...SEARCH_IS_FIELDS_AD_GROUP,
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

export function buildPmaxSearchTermsQuery(opts: BuildOptions): string {
  // PMax exposes search categories (privacy-aggregated, not raw queries) via
  // campaign_search_term_insight. Different shape than search_term_view —
  // returns category labels with metrics scoped to a single PMax campaign.
  // PMax search-term insight does NOT support cost_micros (Google's privacy
  // aggregation hides per-category cost). impressions / clicks / conversions /
  // value are the available metrics.
  const fields = [
    'campaign_search_term_insight.id',
    'campaign_search_term_insight.category_label',
    'metrics.impressions',
    'metrics.clicks',
    'metrics.conversions',
    'metrics.conversions_value',
  ];
  const where = [dateClause(opts.from, opts.to)];
  if (opts.campaignIds?.length === 1) {
    where.push(`campaign_search_term_insight.campaign_id = ${opts.campaignIds[0]}`);
  } else {
    throw new Error('PMax search-term insight requires exactly one campaign ID');
  }
  return `
    SELECT ${fields.join(', ')}
    FROM campaign_search_term_insight
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildAudiencesQuery(opts: BuildOptions): string {
  // Audience-level performance — works for Search / Demand Gen / Display campaigns with audience criteria.
  // campaign_criterion.display_name is the human-readable label for any criterion type.
  // The audience resource (custom audiences) is referenced by campaign_criterion.audience (string resource name);
  // detailed-demographic / affinity / in-market categories come via user_interest.
  const fields = [
    'campaign.id',
    'campaign.name',
    'campaign.advertising_channel_type',
    'campaign_criterion.criterion_id',
    'campaign_criterion.type',
    'campaign_criterion.display_name',
    'campaign_criterion.user_interest.user_interest_category',
    ...METRIC_FIELDS,
  ];
  const where = [dateClause(opts.from, opts.to)];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  return `
    SELECT ${fields.join(', ')}
    FROM campaign_audience_view
    WHERE ${where.join(' AND ')}
  `.trim();
}

export function buildProductsQuery(opts: BuildOptions): string {
  // Shopping product-level metrics. view_through_conversions is not supported on this view.
  const fields = [
    'campaign.id',
    'campaign.name',
    'campaign.advertising_channel_type',
    'segments.product_item_id',
    'segments.product_title',
    'segments.product_brand',
    'segments.product_type_l1',
    'segments.product_type_l2',
    'metrics.cost_micros',
    'metrics.impressions',
    'metrics.clicks',
    'metrics.conversions',
    'metrics.conversions_value',
    'metrics.all_conversions',
    'metrics.all_conversions_value',
    'metrics.cross_device_conversions',
  ];
  const where = [dateClause(opts.from, opts.to)];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  return `
    SELECT ${fields.join(', ')}
    FROM shopping_performance_view
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
  // asset_group_asset returns assets within asset groups with performance labels + metrics.
  // For PMax the metrics will be zero (Google attributes at asset_group level due to AI
  // composition); for non-PMax channels they may be populated.
  const fields = [
    'campaign.id',
    'campaign.name',
    'campaign.advertising_channel_type',
    'asset_group.id',
    'asset_group.name',
    'asset_group_asset.field_type',
    'asset_group_asset.performance_label',
    'asset_group_asset.status',
    'asset.id',
    'asset.type',
    'asset.text_asset.text',
    'asset.image_asset.full_size.url',
    'asset.youtube_video_asset.youtube_video_id',
    ...NARROW_METRIC_FIELDS,
  ];
  const where: string[] = [`asset_group_asset.status != 'REMOVED'`];
  // Date range is required when metric fields are selected; default to last 30 days if not provided
  if (opts.from && opts.to) where.push(dateClause(opts.from, opts.to));
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  if (opts.assetGroupIds?.length) where.push(`asset_group.id IN ${inClause(opts.assetGroupIds)}`);

  return `
    SELECT ${fields.join(', ')}
    FROM asset_group_asset
    WHERE ${where.join(' AND ')}
  `.trim();
}

/**
 * PMax-side video assets: each row is one asset-group attachment of a video.
 * Same youtube_video_id may attach to many asset groups — we aggregate
 * client-side. asset_group_asset returns cost / impressions / clicks
 * attributed to the asset; conversions are NOT exposed at this level for PMax
 * because Google's AI distributes credit at the asset_group level.
 */
export function buildPmaxVideoAssetsQuery(opts: BuildOptions): string {
  const fields = [
    'segments.date',
    'campaign.id',
    'campaign.name',
    'campaign.advertising_channel_type',
    'asset_group.id',
    'asset_group.name',
    'asset_group_asset.performance_label',
    'asset_group_asset.status',
    'asset.id',
    'asset.youtube_video_asset.youtube_video_id',
    'asset.youtube_video_asset.youtube_video_title',
    'metrics.cost_micros',
    'metrics.impressions',
    'metrics.clicks',
  ];
  const where: string[] = [
    `asset_group_asset.field_type = 'YOUTUBE_VIDEO'`,
    `asset_group_asset.status != 'REMOVED'`,
    dateClause(opts.from, opts.to),
  ];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  return `
    SELECT ${fields.join(', ')}
    FROM asset_group_asset
    WHERE ${where.join(' AND ')}
  `.trim();
}

/**
 * Non-PMax video assets (Demand Gen, Video, Display): ad_group_ad_asset_view
 * exposes per-asset cost/impressions/clicks + conversions. Rejects video-
 * specific metrics like video_views / video_view_rate / average_cpv (those
 * only attach to the campaign or ad_group resource for video campaigns).
 */
export function buildDgVideoAssetsQuery(opts: BuildOptions): string {
  const fields = [
    'segments.date',
    'campaign.id',
    'campaign.name',
    'campaign.advertising_channel_type',
    'ad_group.id',
    'ad_group.name',
    'ad_group_ad_asset_view.performance_label',
    'ad_group_ad_asset_view.field_type',
    'asset.id',
    'asset.youtube_video_asset.youtube_video_id',
    'asset.youtube_video_asset.youtube_video_title',
    'metrics.cost_micros',
    'metrics.impressions',
    'metrics.clicks',
    'metrics.conversions',
    'metrics.conversions_value',
  ];
  const where: string[] = [
    `ad_group_ad_asset_view.field_type = 'YOUTUBE_VIDEO'`,
    dateClause(opts.from, opts.to),
  ];
  if (opts.campaignIds?.length) where.push(`campaign.id IN ${inClause(opts.campaignIds)}`);
  return `
    SELECT ${fields.join(', ')}
    FROM ad_group_ad_asset_view
    WHERE ${where.join(' AND ')}
  `.trim();
}

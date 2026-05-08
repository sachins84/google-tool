import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { getBrand } from '../services/brands.js';
import { getCampaignBudgetResource, mutate } from '../services/google-ads.js';
import { getLoginCustomerId } from '../services/mcc-map.js';

/**
 * Mutation router. All ops go through one POST /api/mutate endpoint with an `action` discriminator.
 * Every call is recorded to audit_log — dry runs included.
 */

const baseSchema = z.object({
  brand_id: z.coerce.number(),
  customer_id: z.string().regex(/^\d+$/),
  dry_run: z.boolean().default(true),
});

const pauseEnableSchema = baseSchema.extend({
  action: z.enum(['pause', 'enable']),
  level: z.enum(['campaign', 'ad_group', 'asset_group', 'ad', 'keyword']),
  // for campaign/ad_group/asset_group: just the id. for ad: ad_group_id + ad_id. for keyword: ad_group_id + criterion_id
  campaign_id: z.string().optional(),
  ad_group_id: z.string().optional(),
  asset_group_id: z.string().optional(),
  ad_id: z.string().optional(),
  criterion_id: z.string().optional(),
});

const budgetSchema = baseSchema.extend({
  action: z.literal('update_budget'),
  campaign_id: z.string(),
  daily_budget_inr: z.number().min(0),
});

const negativeKwSchema = baseSchema.extend({
  action: z.literal('add_negative_keyword'),
  scope: z.enum(['campaign', 'ad_group']),
  campaign_id: z.string().optional(),
  ad_group_id: z.string().optional(),
  text: z.string().min(1),
  match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).default('BROAD'),
});

const positiveKwSchema = baseSchema.extend({
  action: z.literal('add_keyword'),
  ad_group_id: z.string(),
  text: z.string().min(1),
  match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).default('BROAD'),
});

const updateSettingsSchema = baseSchema.extend({
  action: z.literal('update_campaign_settings'),
  campaign_id: z.string(),
  // any combo of these may be passed; only changed fields are sent to Google
  name: z.string().min(1).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  target_roas: z.number().min(0.5).max(10).optional(), // ratio (e.g. 4.0 = 400%)
  target_cpa_inr: z.number().min(0).optional(),
});

const createCampaignSchema = baseSchema.extend({
  action: z.literal('create_search_campaign'),
  name: z.string().min(1).max(255),
  daily_budget_inr: z.number().min(50),
  bid_strategy: z.enum(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']).default('MAXIMIZE_CONVERSIONS'),
  target_cpa_inr: z.number().min(0).optional(),
  target_roas: z.number().min(0.5).max(10).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Targeting (defaults: India, English+Hindi). Geo IDs are Google's geo_target_constant IDs.
  geo_target_ids: z.array(z.string()).default(['2356']), // 2356 = India
  language_ids: z.array(z.string()).default(['1000', '1023']), // 1000 = English, 1023 = Hindi
  // Network settings (Search default; partner network optional)
  search_partners: z.boolean().default(false),
  content_network: z.boolean().default(false),
});

// PMax asset operations — text assets are immutable, so "modify" = remove + add
const ASSET_FIELD_TYPES = [
  'HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME',
  'CALL_TO_ACTION_SELECTION', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE',
  'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO', 'YOUTUBE_VIDEO',
] as const;

const assetStatusSchema = baseSchema.extend({
  action: z.enum(['pause_asset', 'enable_asset', 'remove_asset']),
  asset_group_id: z.string(),
  asset_id: z.string(),
  field_type: z.enum(ASSET_FIELD_TYPES),
});

const TEXT_ASSET_LIMITS: Record<string, number> = {
  HEADLINE: 30,
  LONG_HEADLINE: 90,
  DESCRIPTION: 90,
  BUSINESS_NAME: 25,
};

const addTextAssetSchema = baseSchema.extend({
  action: z.literal('add_text_asset'),
  asset_group_id: z.string(),
  field_type: z.enum(['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME']),
  text: z.string().min(1).max(90),
});

const requestSchema = z.discriminatedUnion('action', [
  pauseEnableSchema.extend({ action: z.literal('pause') }),
  pauseEnableSchema.extend({ action: z.literal('enable') }),
  budgetSchema,
  negativeKwSchema,
  positiveKwSchema,
  assetStatusSchema.extend({ action: z.literal('pause_asset') }),
  assetStatusSchema.extend({ action: z.literal('enable_asset') }),
  assetStatusSchema.extend({ action: z.literal('remove_asset') }),
  addTextAssetSchema,
  updateSettingsSchema,
  createCampaignSchema,
]);

const MICROS = 1_000_000;

function pauseEnableStatus(action: 'pause' | 'enable'): 'PAUSED' | 'ENABLED' {
  return action === 'pause' ? 'PAUSED' : 'ENABLED';
}

function buildPauseEnableOps(
  customerId: string,
  level: 'campaign' | 'ad_group' | 'asset_group' | 'ad' | 'keyword',
  status: 'PAUSED' | 'ENABLED',
  ids: { campaign_id?: string; ad_group_id?: string; asset_group_id?: string; ad_id?: string; criterion_id?: string }
): Array<Record<string, unknown>> {
  if (level === 'campaign') {
    if (!ids.campaign_id) throw new Error('campaign_id required');
    return [{
      campaignOperation: {
        update: { resourceName: `customers/${customerId}/campaigns/${ids.campaign_id}`, status },
        updateMask: 'status',
      },
    }];
  }
  if (level === 'ad_group') {
    if (!ids.ad_group_id) throw new Error('ad_group_id required');
    return [{
      adGroupOperation: {
        update: { resourceName: `customers/${customerId}/adGroups/${ids.ad_group_id}`, status },
        updateMask: 'status',
      },
    }];
  }
  if (level === 'asset_group') {
    if (!ids.asset_group_id) throw new Error('asset_group_id required');
    return [{
      assetGroupOperation: {
        update: { resourceName: `customers/${customerId}/assetGroups/${ids.asset_group_id}`, status },
        updateMask: 'status',
      },
    }];
  }
  if (level === 'ad') {
    if (!ids.ad_group_id || !ids.ad_id) throw new Error('ad_group_id and ad_id required');
    return [{
      adGroupAdOperation: {
        update: {
          resourceName: `customers/${customerId}/adGroupAds/${ids.ad_group_id}~${ids.ad_id}`,
          status,
        },
        updateMask: 'status',
      },
    }];
  }
  // keyword
  if (!ids.ad_group_id || !ids.criterion_id) throw new Error('ad_group_id and criterion_id required');
  return [{
    adGroupCriterionOperation: {
      update: {
        resourceName: `customers/${customerId}/adGroupCriteria/${ids.ad_group_id}~${ids.criterion_id}`,
        status,
      },
      updateMask: 'status',
    },
  }];
}

export async function mutateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/', async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    const brand = getBrand(body.brand_id);
    if (!brand) return reply.code(404).send({ error: 'Brand not found' });

    // Authorisation guard: user can only mutate accounts that belong to the selected brand.
    const linkedIds = new Set(brand.accounts.map((a) => a.customer_id));
    if (!linkedIds.has(body.customer_id)) {
      return reply.code(403).send({ error: 'Customer not linked to this brand' });
    }

    let operations: Array<Record<string, unknown>> = [];
    let actionLabel: string = body.action;
    let before: unknown = undefined;
    let after: unknown = undefined;
    let target: string;

    try {
      if (body.action === 'pause' || body.action === 'enable') {
        const status = pauseEnableStatus(body.action);
        operations = buildPauseEnableOps(body.customer_id, body.level, status, body);
        target =
          body.level === 'campaign'
            ? `customers/${body.customer_id}/campaigns/${body.campaign_id}`
            : body.level === 'ad_group'
            ? `customers/${body.customer_id}/adGroups/${body.ad_group_id}`
            : body.level === 'asset_group'
            ? `customers/${body.customer_id}/assetGroups/${body.asset_group_id}`
            : body.level === 'ad'
            ? `customers/${body.customer_id}/adGroupAds/${body.ad_group_id}~${body.ad_id}`
            : `customers/${body.customer_id}/adGroupCriteria/${body.ad_group_id}~${body.criterion_id}`;
        actionLabel = `${body.action}_${body.level}`;
        after = { status };
      } else if (body.action === 'update_budget') {
        const loginCustomerId = (await getLoginCustomerId(body.customer_id)) ?? undefined;
        const budget = await getCampaignBudgetResource(body.customer_id, body.campaign_id, loginCustomerId);
        if (!budget) return reply.code(404).send({ error: 'Campaign budget not found' });
        before = { amount_inr: budget.amountMicros / MICROS };
        const newAmountMicros = Math.round(body.daily_budget_inr * MICROS);
        after = { amount_inr: body.daily_budget_inr };
        operations = [{
          campaignBudgetOperation: {
            update: { resourceName: budget.resourceName, amountMicros: String(newAmountMicros) },
            updateMask: 'amount_micros',
          },
        }];
        target = budget.resourceName;
      } else if (body.action === 'pause_asset' || body.action === 'enable_asset') {
        const status = body.action === 'pause_asset' ? 'PAUSED' : 'ENABLED';
        target = `customers/${body.customer_id}/assetGroupAssets/${body.asset_group_id}~${body.asset_id}~${body.field_type}`;
        operations = [{
          assetGroupAssetOperation: {
            update: { resourceName: target, status },
            updateMask: 'status',
          },
        }];
        actionLabel = body.action;
        before = { status: body.action === 'pause_asset' ? 'ENABLED' : 'PAUSED' };
        after = { status };
      } else if (body.action === 'remove_asset') {
        target = `customers/${body.customer_id}/assetGroupAssets/${body.asset_group_id}~${body.asset_id}~${body.field_type}`;
        operations = [{
          assetGroupAssetOperation: { remove: target },
        }];
        actionLabel = 'remove_asset';
        after = { removed: true };
      } else if (body.action === 'add_text_asset') {
        const limit = TEXT_ASSET_LIMITS[body.field_type];
        if (limit && body.text.length > limit) {
          return reply.code(400).send({
            error: `${body.field_type} exceeds ${limit}-character limit (got ${body.text.length})`,
          });
        }
        // Two-op batch with temp resource name. Google Ads accepts negative IDs as
        // placeholders that resolve to the actual asset created in op 1.
        const tempAssetResource = `customers/${body.customer_id}/assets/-1`;
        target = `customers/${body.customer_id}/assetGroups/${body.asset_group_id}`;
        operations = [
          {
            assetOperation: {
              create: {
                resourceName: tempAssetResource,
                textAsset: { text: body.text },
              },
            },
          },
          {
            assetGroupAssetOperation: {
              create: {
                assetGroup: target,
                asset: tempAssetResource,
                fieldType: body.field_type,
              },
            },
          },
        ];
        actionLabel = `add_text_asset_${body.field_type.toLowerCase()}`;
        after = { field_type: body.field_type, text: body.text };
      } else if (body.action === 'add_keyword') {
        target = `customers/${body.customer_id}/adGroups/${body.ad_group_id}`;
        operations = [{
          adGroupCriterionOperation: {
            create: {
              adGroup: target,
              keyword: { text: body.text, matchType: body.match_type },
            },
          },
        }];
        actionLabel = 'add_keyword';
        after = { text: body.text, match_type: body.match_type };
      } else if (body.action === 'update_campaign_settings') {
        target = `customers/${body.customer_id}/campaigns/${body.campaign_id}`;
        const update: Record<string, unknown> = { resourceName: target };
        const updateMaskParts: string[] = [];
        if (body.name) { update.name = body.name; updateMaskParts.push('name'); }
        if (body.start_date) { update.startDate = body.start_date; updateMaskParts.push('start_date'); }
        if (body.end_date) { update.endDate = body.end_date; updateMaskParts.push('end_date'); }
        if (body.target_roas != null) {
          // For TARGET_ROAS bid strategy: Google expects target_roas as a fraction (e.g. 4.0)
          update.maximizeConversionValue = { targetRoas: body.target_roas };
          updateMaskParts.push('maximize_conversion_value.target_roas');
        }
        if (body.target_cpa_inr != null) {
          update.maximizeConversions = { targetCpaMicros: String(Math.round(body.target_cpa_inr * MICROS)) };
          updateMaskParts.push('maximize_conversions.target_cpa_micros');
        }
        if (updateMaskParts.length === 0) {
          return reply.code(400).send({ error: 'No fields to update — pass at least one of: name, start_date, end_date, target_roas, target_cpa_inr' });
        }
        operations = [{
          campaignOperation: { update, updateMask: updateMaskParts.join(',') },
        }];
        actionLabel = 'update_campaign_settings';
        after = {
          ...(body.name ? { name: body.name } : {}),
          ...(body.start_date ? { start_date: body.start_date } : {}),
          ...(body.end_date ? { end_date: body.end_date } : {}),
          ...(body.target_roas != null ? { target_roas: body.target_roas } : {}),
          ...(body.target_cpa_inr != null ? { target_cpa_inr: body.target_cpa_inr } : {}),
        };
      } else if (body.action === 'create_search_campaign') {
        // Two-op batch: create budget then campaign that references it via temp resource name
        const tempBudget = `customers/${body.customer_id}/campaignBudgets/-1`;
        target = `customers/${body.customer_id}/campaigns/-2`;

        const campaign: Record<string, unknown> = {
          resourceName: target,
          name: body.name,
          status: 'PAUSED', // safer default — user enables after review
          advertisingChannelType: 'SEARCH',
          campaignBudget: tempBudget,
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: body.search_partners,
            targetContentNetwork: body.content_network,
            targetPartnerSearchNetwork: false,
          },
          // EU political advertising is a required disclosure field. We default to
          // "does not contain" — caller may override later via update if needed.
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        };
        if (body.start_date) campaign.startDate = body.start_date;
        if (body.end_date) campaign.endDate = body.end_date;

        // Bid strategy
        switch (body.bid_strategy) {
          case 'MAXIMIZE_CONVERSIONS':
            campaign.maximizeConversions = body.target_cpa_inr != null
              ? { targetCpaMicros: String(Math.round(body.target_cpa_inr * MICROS)) }
              : {};
            break;
          case 'MAXIMIZE_CONVERSION_VALUE':
            campaign.maximizeConversionValue = body.target_roas != null
              ? { targetRoas: body.target_roas }
              : {};
            break;
          case 'TARGET_CPA':
            if (body.target_cpa_inr == null) return reply.code(400).send({ error: 'target_cpa_inr required for TARGET_CPA bid strategy' });
            campaign.targetCpa = { targetCpaMicros: String(Math.round(body.target_cpa_inr * MICROS)) };
            break;
          case 'TARGET_ROAS':
            if (body.target_roas == null) return reply.code(400).send({ error: 'target_roas required for TARGET_ROAS bid strategy' });
            campaign.targetRoas = { targetRoas: body.target_roas };
            break;
        }

        operations = [
          {
            campaignBudgetOperation: {
              create: {
                resourceName: tempBudget,
                name: `${body.name} budget`,
                amountMicros: String(Math.round(body.daily_budget_inr * MICROS)),
                deliveryMethod: 'STANDARD',
                explicitlyShared: false,
              },
            },
          },
          { campaignOperation: { create: campaign } },
        ];

        // Geo + language criteria — created as separate operations after the campaign
        for (const geoId of body.geo_target_ids) {
          operations.push({
            campaignCriterionOperation: {
              create: {
                campaign: target,
                location: { geoTargetConstant: `geoTargetConstants/${geoId}` },
              },
            },
          });
        }
        for (const langId of body.language_ids) {
          operations.push({
            campaignCriterionOperation: {
              create: {
                campaign: target,
                language: { languageConstant: `languageConstants/${langId}` },
              },
            },
          });
        }

        actionLabel = 'create_search_campaign';
        after = {
          name: body.name,
          daily_budget_inr: body.daily_budget_inr,
          bid_strategy: body.bid_strategy,
          target_cpa_inr: body.target_cpa_inr,
          target_roas: body.target_roas,
          status: 'PAUSED',
        };
      } else {
        // add_negative_keyword
        if (body.scope === 'campaign') {
          if (!body.campaign_id) return reply.code(400).send({ error: 'campaign_id required' });
          target = `customers/${body.customer_id}/campaigns/${body.campaign_id}`;
          operations = [{
            campaignCriterionOperation: {
              create: {
                campaign: target,
                negative: true,
                keyword: { text: body.text, matchType: body.match_type },
              },
            },
          }];
        } else {
          if (!body.ad_group_id) return reply.code(400).send({ error: 'ad_group_id required' });
          target = `customers/${body.customer_id}/adGroups/${body.ad_group_id}`;
          operations = [{
            adGroupCriterionOperation: {
              create: {
                adGroup: target,
                negative: true,
                keyword: { text: body.text, matchType: body.match_type },
              },
            },
          }];
        }
        actionLabel = `add_negative_keyword_${body.scope}`;
        after = { text: body.text, match_type: body.match_type };
      }

      const loginCustomerId = (await getLoginCustomerId(body.customer_id)) ?? undefined;
      const response = await mutate(body.customer_id, operations, body.dry_run, loginCustomerId);

      recordAudit({
        user_id: req.user?.id ?? null,
        action: actionLabel,
        brand_id: body.brand_id,
        customer_id: body.customer_id,
        target_resource: target,
        before_json: before,
        after_json: after,
        dry_run: body.dry_run,
        response_json: response,
      });

      return { ok: true, dry_run: body.dry_run, response };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Record failed attempts to the audit log too — useful for debugging
      recordAudit({
        user_id: req.user?.id ?? null,
        action: `${actionLabel}_failed`,
        brand_id: body.brand_id,
        customer_id: body.customer_id,
        target_resource: 'unknown',
        before_json: undefined,
        after_json: undefined,
        dry_run: body.dry_run,
        response_json: { error: message },
      });

      app.log.error({ err: message, action: actionLabel }, 'mutation failed');
      return reply.code(500).send({ error: message });
    }
  });
}

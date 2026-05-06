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
    let actionLabel = body.action;
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

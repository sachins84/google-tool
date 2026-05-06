/**
 * Pre-configured Redshift funnel mappings keyed by brand name.
 * When a brand with a matching (normalized) name is created or updated,
 * we auto-populate brand_redshift_config so calc ROAS works out of the box.
 *
 * Users can still edit/override via the Settings tab.
 */

interface BrandPreset {
  funnel_table: string;
  utm_source_list: string[];
}

// All keys MUST be normalized via normalizeBrandName().
const PRESETS: Record<string, BrandPreset> = {
  littlejoys: {
    funnel_table: 'mw_nexus.lj_funnel_daily',
    utm_source_list: ['google_Pmax', 'google_Search', 'google_DG', 'google_pla', 'google_Pmax_RM', 'google'],
  },
  manmatters: {
    funnel_table: 'mw_nexus.mm_funnel_daily',
    utm_source_list: [
      'google_Pmax', 'google_Pmax-MM02', 'google_Pmax-MM03',
      'google_Search', 'google_DG',
      'google_pla', 'google_pla_03',
      'google',
    ],
  },
  bebodywise: {
    funnel_table: 'mw_nexus.bw_funnel_daily',
    utm_source_list: ['google_Pmax', 'google_Search', 'google_DG', 'google_pla', 'google'],
  },
};

/** Strip non-alphanumerics + lowercase so 'Be Bodywise' / 'BeBodywise' / 'be-bodywise' all match. */
export function normalizeBrandName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function getBrandPreset(name: string): BrandPreset | null {
  const key = normalizeBrandName(name);
  return PRESETS[key] ?? null;
}

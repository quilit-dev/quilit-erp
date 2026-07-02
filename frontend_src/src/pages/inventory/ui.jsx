// Shared leaf pieces for the Inventory page: unit/type enums, number
// formatting, and the small category/type/lot badges.
import { useLocale } from '../../hooks/useLocale.jsx';

export const UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'm', 'm²', 'm³', 'box', 'roll', 'set', 'pair'];
export const PRODUCT_TYPES = ['raw_material', 'semi_finished', 'finished', 'consumable'];
export const PRODUCT_TYPE_COLORS = {
  raw_material:  { bg: '#EFF6FF', color: '#2563EB' },
  semi_finished: { bg: '#FFFBEB', color: '#D97706' },
  finished:      { bg: '#ECFDF5', color: '#059669' },
  consumable:    { bg: '#F5F3FF', color: '#7C3AED' },
};

export { fmtNum } from '../../utils/format';

export function CategoryBadge({ category }) {
  const { tCategory } = useLocale();
  if (!category) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  return <span className="badge badge-accent">{tCategory(category)}</span>;
}

export function ProductTypeBadge({ type }) {
  const { t, tCategory } = useLocale();
  if (!type) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const s = PRODUCT_TYPE_COLORS[type] || { bg: '#F3F4F6', color: '#6B7280' };
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 8px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', background: s.bg, color: s.color,
    }}>{t(`inventory.ptype_${type}`)}</span>
  );
}
export const LOT_STATUS_BADGE = {
  expired:  { cls: 'badge-red',    key: 'inventory.expExpired' },
  expiring: { cls: 'badge-yellow', key: 'inventory.expExpiring' },
  ok:       { cls: 'badge-green',  key: 'inventory.expOk' },
  none:     { cls: 'badge-muted',  key: null },
};

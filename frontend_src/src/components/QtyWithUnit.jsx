import { NumberInput } from './shared';

/**
 * A quantity box that says what it counts: "5 kg", "12 pcs". The unit comes
 * from the stock item the line was picked from; a typed line has none and the
 * box is a plain number. The unit sits inside the box, at its end, so the
 * column keeps its width and the figure and its unit read as one.
 */
export default function QtyWithUnit({ unit, style, ...props }) {
  const u = (unit || '').trim();
  return (
    <div style={{ position: 'relative' }}>
      <NumberInput {...props} className="form-control"
        style={{ ...(style || {}), width: '100%', ...(u ? { paddingInlineEnd: `${Math.min(u.length, 5) * 7 + 14}px` } : {}) }} />
      {u && (
        <span aria-hidden="true" style={{
          position: 'absolute', insetInlineEnd: 8, top: '50%', transform: 'translateY(-50%)',
          fontSize: 11, color: 'var(--text-3)', pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>{u}</span>
      )}
    </div>
  );
}

// Shared layout atoms for the Settings page (also used by its sections).
import { Icon } from '../../components/shared';

export const Section = ({ title, icon, children }) => (
  <div className="card" style={{ marginBottom: 24, overflow: 'hidden' }}>
    <div className="card-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'inline-flex', color: 'var(--accent)' }}>
          <Icon name={icon} size={17} strokeWidth={1.9} />
        </span>
        <h3 className="card-title" style={{ fontSize: 15 }}>{title}</h3>
      </div>
    </div>
    <div className="card-body">{children}</div>
  </div>
);

export const Field = ({ label, hint, children }) => (
  <div className="form-group">
    <label className="form-label">
      {label}
      {hint && (
        <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 6, fontSize: 11 }}>
          {hint}
        </span>
      )}
    </label>
    {children}
  </div>
);

export const Input = ({ value, onChange, type = 'text', placeholder, disabled }) => (
  <input
    type={type}
    value={value}
    onChange={e => !disabled && onChange(e.target.value)}
    placeholder={placeholder}
    className="form-control"
    disabled={disabled}
    style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
  />
);

export const Textarea = ({ value, onChange, placeholder, disabled, rows = 5 }) => (
  <textarea
    rows={rows}
    value={value}
    onChange={e => !disabled && onChange(e.target.value)}
    placeholder={placeholder}
    className="form-control"
    disabled={disabled}
    style={{ resize: 'vertical', ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
  />
);

export const Toggle = ({ label, checked, onChange, disabled }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none', opacity: disabled ? 0.6 : 1 }}>
    <div
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 12,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        position: 'relative', transition: 'background 0.2s',
        flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: checked ? 23 : 3,
        width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.25)',
      }} />
    </div>
    <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{label}</span>
  </label>
);

// Lebanon SMB market: USD functional currency + LBP secondary only.
export const CURRENCIES = ['USD', 'LBP'];

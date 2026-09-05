/**
 * A bordered surface with an optional header — the shape nearly every screen
 * in this app is built from.
 *
 * `.card` and `.card-header` already existed; what did not was an agreed
 * shape for the header. It was overridden inline about fifteen times, in
 * exactly two ways: a title with actions pushed to the far side, and a stacked
 * full-width filter bar. Those two are what `PanelHeader` offers.
 *
 * Deliberately thin. It keeps the existing class names, so a converted panel
 * and an unconverted one are indistinguishable and pages can move one at a
 * time; and it does not try to cover every header ever written — anything
 * unusual passes children straight through, which is cheaper to read than a
 * primitive with a dozen props.
 */
export default function Panel({ className = '', children, ...rest }) {
  return (
    <div className={`card ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, subtitle, actions, stacked, className = '', children, ...rest }) {
  const cls = ['card-header', stacked ? 'card-header-stacked' : 'card-header-split', className]
    .filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      {title ? (
        <div className="card-header-titles">
          <h2 className="card-title">{title}</h2>
          {subtitle ? <p className="card-subtitle">{subtitle}</p> : null}
        </div>
      ) : null}
      {children}
      {actions ? <div className="card-header-actions">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({ className = '', children, ...rest }) {
  return (
    <div className={`card-body ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

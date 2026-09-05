import { Link } from 'react-router-dom';

/**
 * The top of a page: where you are, what this screen is, and what you can do
 * from it.
 *
 * Thirty-three pages had each written this shape by hand — a `.page-header`
 * div, a title, a count line, and an action cluster held together by an inline
 * `style={{display:'flex',gap:8}}`. They drifted: different gaps, different
 * vertical alignment, some with the subtitle inside the heading block and some
 * outside. This is that shape, once.
 *
 * ADDITIVE ON PURPOSE. It keeps the existing `page-header` / `page-title` /
 * `page-subtitle` class names, so a page that adopts it looks identical to one
 * that has not, and the 33 can convert one at a time instead of in a single
 * commit. Nothing about the CSS changes here.
 *
 * The action slot takes whatever the page already rendered. It deliberately
 * does not try to build buttons from a config array: every page's actions are
 * different, half of them are permission-gated, and a prop-driven button
 * factory would have to reimplement all of that.
 */
export default function PageMasthead({ title, subtitle, breadcrumb, actions, id }) {
  return (
    <div className="page-header">
      <div>
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="page-breadcrumb" aria-label="Breadcrumb">
            {breadcrumb.map((crumb, i) => (
              <span key={crumb.to || crumb.label}>
                {i > 0 && <span className="page-breadcrumb-sep" aria-hidden="true">/</span>}
                {crumb.to
                  ? <Link to={crumb.to}>{crumb.label}</Link>
                  : <span>{crumb.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 className="page-title" id={id}>{title}</h1>
        {/* Rendered only when there is something to say. An empty <p> still
            claims its line-height, so a page without a count line would sit a
            few pixels differently from one with it. */}
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

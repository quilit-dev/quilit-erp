// Route-level error boundary — the runtime containment for the "white
// screen" bug class. A render error inside a page replaces ONLY the page
// content with a recover panel; the sidebar/topbar stay alive so the user
// can navigate away. App.jsx keys this by route path, so simply navigating
// to another page resets the boundary automatically.
//
// Class component by necessity: error boundaries have no hooks API, so the
// translated strings come in via the `t` prop from the wrapping route.
import { Component } from 'react';
import { ReportProblemDialog } from './ReportProblem';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: '', showReport: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the component stack so a report can carry it. React gives it here
    // and nowhere else, so it has to be captured at catch time.
    this.setState({ componentStack: info?.componentStack || '' });
    // Surface the real stack in the console — the panel stays calm, the
    // developer console keeps the diagnostic detail.
    console.error('Page render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const t = this.props.t || ((k) => k);
    return (
      <div className="card" style={{ margin: 24, textAlign: 'center' }}>
        <div className="card-body" style={{ padding: '48px 24px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }} aria-hidden>⚠️</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>
            {t('common.pageErrorTitle')}
          </h2>
          <p style={{ margin: '0 0 6px', color: 'var(--text-2)', fontSize: 13 }}>
            {t('common.pageErrorBody')}
          </p>
          <p className="text-mono" style={{ margin: '0 0 20px', color: 'var(--text-3)', fontSize: 12 }}>
            {String(error?.message || error)}
          </p>
          {/* No Retry. Clearing the error re-renders the same component from
              the same state that just threw, so it threw again — a button
              whose only reliable effect was to make the panel flicker.
              Reloading is the one that actually starts over. */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              {t('common.pageErrorReload')}
            </button>
            {/* Opens the same dialog as the topbar action. The crash detail
                is attached automatically, but the user still gets to say what
                they were doing — firing blind lost the one piece of context
                only they have. */}
            <button className="btn btn-secondary"
              onClick={() => this.setState({ showReport: true })}>
              {t('common.reportProblem')}
            </button>
          </div>
          {this.state.showReport && (
            <ReportProblemDialog
              error={error}
              componentStack={this.state.componentStack}
              onClose={() => this.setState({ showReport: false })} />
          )}
        </div>
      </div>
    );
  }
}

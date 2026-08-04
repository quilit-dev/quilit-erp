// Route-level error boundary — the runtime containment for the "white
// screen" bug class. A render error inside a page replaces ONLY the page
// content with a recover panel; the sidebar/topbar stay alive so the user
// can navigate away. App.jsx keys this by route path, so simply navigating
// to another page resets the boundary automatically.
//
// Class component by necessity: error boundaries have no hooks API, so the
// translated strings come in via the `t` prop from the wrapping route.
import { Component } from 'react';
import { reportProblem } from '../api/client';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: '', reporting: false, reported: false };
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

  async report() {
    const { error, componentStack } = this.state;
    this.setState({ reporting: true });
    try {
      await reportProblem({
        title: `Page crash: ${String(error?.message || error).slice(0, 200)}`,
        message: String(error?.message || error),
        stack: [error?.stack, componentStack].filter(Boolean).join('\n\n'),
        page_url: window.location.href,
        user_agent: navigator.userAgent,
        severity: 'high',            // a render crash blanked a page for a user
      });
      this.setState({ reported: true, reporting: false });
    } catch {
      // Reporting must never throw on top of the error being reported.
      this.setState({ reporting: false });
    }
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
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
              {t('common.retry')}
            </button>
            <button className="btn btn-secondary" onClick={() => window.location.reload()}>
              {t('common.pageErrorReload')}
            </button>
            {/* Reporting is one click: everything technical is already known
                here, so the user is never asked to describe a stack trace. */}
            <button className="btn btn-secondary"
              disabled={this.state.reporting || this.state.reported}
              onClick={() => this.report()}>
              {this.state.reported ? t('common.problemReported')
                : this.state.reporting ? t('common.sending')
                : t('common.reportProblem')}
            </button>
          </div>
          {this.state.reported && (
            <p style={{ marginTop: 12, fontSize: 12.5, color: 'var(--green)' }}>
              {t('common.problemReportedHint')}
            </p>
          )}
        </div>
      </div>
    );
  }
}

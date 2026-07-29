import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors so a single bad component does not leave a blank page.
 *
 * Without this, any throw during render unmounts the whole tree and the user is left
 * staring at white with no way back other than guessing at the URL.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="page">
        <div className="form-card" style={{ maxWidth: '640px', margin: '3rem auto' }}>
          <h1>Something went wrong</h1>
          <p className="muted">
            The page failed to load. Your data has not been changed. Reloading usually
            clears this; if it keeps happening, contact the Athletics Business Office and
            mention what you were doing.
          </p>
          <pre
            style={{
              background: '#f8f9fa', padding: '12px', borderRadius: '6px',
              fontSize: '0.8rem', overflowX: 'auto', margin: '16px 0',
            }}
          >
            {error.message}
          </pre>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload the page
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => { window.location.href = '/dashboard'; }}
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

/** Keep a render failure visible and recoverable instead of leaving a blank canvas. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Agent Studio render failure', error, info.componentStack);
  }

  private handleReload = (): void => {
    globalThis.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="grain canvas-bg flex min-h-screen items-center justify-center px-6" role="alert">
        <section className="ui-surface ui-surface-lg ui-dialog rule-lead max-w-md text-center">
          <h1 className="text-xl">Agent Studio couldn’t render this workspace.</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Your workspace is still saved. Reload to reconnect and try again.
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-primary mt-5"
            onClick={this.handleReload}
          >
            Reload Agent Studio
          </button>
        </section>
      </main>
    );
  }
}

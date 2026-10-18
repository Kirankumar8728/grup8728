'use client';

import React, { Component, ReactNode } from 'react';
import { AuthProvider } from './AuthProvider';
import { WebVitalsMonitor } from './WebVitalsMonitor';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ClientProvidersErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ClientProviders ErrorBoundary Notice]:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return <>{this.props.children}</>;
    }
    return this.props.children;
  }
}

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <ClientProvidersErrorBoundary>
      <AuthProvider>
        <WebVitalsMonitor />
        {children}
      </AuthProvider>
    </ClientProvidersErrorBoundary>
  );
}

export default ClientProviders;

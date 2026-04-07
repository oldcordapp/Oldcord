import React, { Component } from 'react';

class FermiErrorBoundary extends Component {
 constructor(props) {
    super(props);

    this.state = {
      hasError: false,
    };
 }

 static getDerivedStateFromError() {
    return {
      hasError: true,
    };
 }

 componentDidCatch(error, info) {
    const fermi = typeof window !== 'undefined' ? window.Fermi : null;
    let handled = false;

    if (fermi) {
      if (typeof fermi.captureException === 'function') {
        fermi.captureException(error, {
          extra: {
            componentStack: info && info.componentStack,
            view: this.props.view,
          },
        });
        handled = true;
      } else if (typeof fermi.logError === 'function') {
        fermi.logError(error, info);
        handled = true;
      }
    }

    if (!handled) {
      console.error(error, info);
    }
 }

 render() {
    if (this.state.hasError) {
      return <div className={'main-view-error'}>Something went wrong.</div>;
    }

    return this.props.children;
 }
}

export default function Main(props) {
 return (
    <FermiErrorBoundary view={props.view}>
      {props.children}
    </FermiErrorBoundary>
 );
}

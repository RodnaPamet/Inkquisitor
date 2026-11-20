'use client';

/**
 * The boundary the story canvas renders inside (Phase 3.1).
 *
 * tldraw is a large third-party renderer loaded on demand; if it throws (a
 * chunk that failed to load, a record it refuses, a browser it cannot run
 * in) the page around it must survive and say so. The map is rows on the
 * server, so nothing is lost: the fallback says that, and "Try again"
 * remounts the canvas. The error is never shown (it may quote a record).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

function CanvasFailure({ onRetry }: { onRetry: () => void }) {
    const t = useTranslations('canvas.boundary');
    return (
        <div role="alert" data-testid="canvas-error-boundary" className="flex h-full min-h-64 flex-col items-center justify-center gap-default p-default text-center">
            <p className="text-sm font-medium text-content-emphasis">{t('title')}</p>
            <p className="max-w-md text-sm text-content-muted">{t('body')}</p>
            <Button variant="secondary" onClick={onRetry}>
                {t('retry')}
            </Button>
        </div>
    );
}

interface Props {
    children: ReactNode;
    /** Told about the failure (a test, or a host that reports it); never shown. */
    onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
    failed: boolean;
    attempt: number;
}

export class CanvasErrorBoundary extends Component<Props, State> {
    override state: State = { failed: false, attempt: 0 };

    static getDerivedStateFromError(): Partial<State> {
        return { failed: true };
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        this.props.onError?.(error, info);
    }

    private readonly retry = () => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));

    override render() {
        if (this.state.failed) return <CanvasFailure onRetry={this.retry} />;
        // A fresh key per attempt, so "Try again" mounts the canvas anew.
        return <div key={this.state.attempt} className="contents">{this.props.children}</div>;
    }
}

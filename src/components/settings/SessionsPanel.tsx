'use client';

/**
 * The person's live sessions, the current one marked. Signing one (or all the
 * others) out is a destructive action, so it follows the undo-toast
 * convention: the row leaves the list at once, and the request is sent when
 * the undo window closes. The revoked browser is signed out on its next
 * request (the `jwt` callback refuses its session).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToastWithUndo } from '@/components/ui/hooks';
import { formatDateTime } from '@inkquisitor/ui/lib/format-date';
import type { SessionView } from '@/app-layer/usecases/sessions';

async function send(url: string, method: 'POST' | 'DELETE'): Promise<void> {
    const res = await fetch(url, { method });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function SessionsPanel({ initialSessions }: { initialSessions: SessionView[] }) {
    const t = useTranslations('settingsPage.sessions');
    const [sessions, setSessions] = useState(initialSessions);
    const triggerUndo = useToastWithUndo();
    const others = sessions.filter((s) => !s.current);

    function revokeOne(session: SessionView) {
        const snapshot = sessions;
        setSessions((rows) => rows.filter((r) => r.id !== session.id));
        triggerUndo({
            message: t('revokedOne'),
            undoMessage: t('undo'),
            action: () => send(`/api/account/sessions/${encodeURIComponent(session.id)}`, 'DELETE'),
            undoAction: () => setSessions(snapshot),
            onError: () => {
                setSessions(snapshot);
                toast.error(t('failed'));
            },
        });
    }

    function revokeOthers() {
        const snapshot = sessions;
        setSessions((rows) => rows.filter((r) => r.current));
        triggerUndo({
            message: t('revokedOthers'),
            undoMessage: t('undo'),
            action: () => send('/api/account/sessions/revoke-others', 'POST'),
            undoAction: () => setSessions(snapshot),
            onError: () => {
                setSessions(snapshot);
                toast.error(t('failed'));
            },
        });
    }

    return (
        <Card className="space-y-default p-6" id="settings-sessions">
            <div className="flex flex-wrap items-start justify-between gap-default">
                <div className="space-y-tight">
                    <h2 className="text-lg font-semibold text-content-emphasis">{t('title')}</h2>
                    <p className="text-sm text-content-muted">{t('description')}</p>
                </div>
                <Button variant="secondary" disabled={others.length === 0} onClick={revokeOthers} id="sessions-revoke-others" text={t('revokeOthers')} />
            </div>
            <ul className="divide-y divide-[var(--border-subtle)]" id="sessions-list">
                {sessions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-default py-3" data-session-id={s.id}>
                        <div className="min-w-0 space-y-tight">
                            <p className="truncate text-sm font-medium text-content-default">
                                {s.userAgent ?? t('unknownDevice')}
                                {s.current ? <span className="ml-2 text-xs text-content-muted">({t('current')})</span> : null}
                            </p>
                            <p className="text-xs text-content-muted">
                                {t('signedIn', { date: formatDateTime(s.createdAt) })} · {t('lastActive', { date: formatDateTime(s.lastActiveAt) })}
                            </p>
                        </div>
                        {!s.current ? <Button variant="secondary" size="sm" onClick={() => revokeOne(s)} text={t('revoke')} /> : null}
                    </li>
                ))}
            </ul>
            {others.length === 0 ? <p className="text-sm text-content-muted">{t('none')}</p> : null}
        </Card>
    );
}

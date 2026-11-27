'use client';

/**
 * "Your data" (Phase 5.H-a, D36): the OWNER's two whole-workspace actions.
 *
 *   Export everything   one AES-256 encrypted zip of everything the workspace holds, protected by a passphrase the
 *                       author types here and again to confirm. It is judged by the server's own rule
 *                       (`passphraseRefusal`) before it is sent, travels in the POST body only, and is never kept: the
 *                       dialog clears it when it closes. The download goes through `bibleDownload`, so a refusal is
 *                       shown rather than saved.
 *   Delete workspace    the typed-confirmation modal CLAUDE.md asks for a top-level entity: the workspace's name typed
 *                       exactly; optionally the author's own account too (only when this is their only workspace — the
 *                       server says so otherwise). It closes the workspace at once; an OWNER restores it within 30
 *                       days from the page a signed-in person with no workspace lands on; then it is deleted for good.
 *
 * Offered only to a viewer the server says may (`workspace.export`, `workspace.delete`: the OWNER).
 */
import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { formatDate } from '@inkquisitor/ui/lib/format-date';
import { BIBLE_API, bibleDownload, bibleFetch, reasonOf } from '@/lib/bible/api-client';
import { PASSPHRASE_MIN_CHARS, passphraseRefusal } from '@/lib/export/passphrase';
import { WORKSPACE_RESTORE_DAYS, workspaceRestorableUntil } from '@/lib/workspace/workspace-retention';

export interface YourDataPanelProps {
    workspaceSlug: string;
    workspaceName: string;
    canExport: boolean;
    canDelete: boolean;
}

export function YourDataPanel({ workspaceSlug, workspaceName, canExport, canDelete }: YourDataPanelProps) {
    const t = useTranslations('settingsPage.yourData');
    const [exportOpen, setExportOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    if (!canExport && !canDelete) return null;
    return (
        <section aria-labelledby="your-data-heading" data-testid="your-data">
            <Card className="space-y-default p-6">
                <h2 id="your-data-heading" className="text-lg font-semibold text-content-emphasis">
                    {t('title')}
                </h2>
                {canExport ? (
                    <div className="space-y-tight">
                        <p className="text-sm text-content-muted">{t('exportHelp')}</p>
                        <Button variant="secondary" icon={<Archive className="size-4" aria-hidden="true" />} onClick={() => setExportOpen(true)} id="workspace-export-open">
                            {t('export')}
                        </Button>
                    </div>
                ) : null}
                {canDelete ? (
                    <div className="space-y-tight">
                        <p className="text-sm text-content-muted">{t('deleteHelp', { days: WORKSPACE_RESTORE_DAYS })}</p>
                        <Button variant="destructive" icon={<Trash2 className="size-4" aria-hidden="true" />} onClick={() => setDeleteOpen(true)} id="workspace-delete-open">
                            {t('delete')}
                        </Button>
                    </div>
                ) : null}
            </Card>
            {canExport ? <ExportModal open={exportOpen} setOpen={setExportOpen} workspaceSlug={workspaceSlug} /> : null}
            {canDelete ? <DeleteWorkspaceModal open={deleteOpen} setOpen={setDeleteOpen} workspaceSlug={workspaceSlug} workspaceName={workspaceName} /> : null}
        </section>
    );
}

function ExportModal({ open, setOpen, workspaceSlug }: { open: boolean; setOpen: Dispatch<SetStateAction<boolean>>; workspaceSlug: string }) {
    const t = useTranslations('settingsPage.yourData.exportDialog');
    const [passphrase, setPassphrase] = useState('');
    const [again, setAgain] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) return;
        // The passphrase is never kept: cleared as the dialog closes.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPassphrase('');
        setAgain('');
        setError(null);
    }, [open]);

    const refusal = passphraseRefusal(passphrase);
    const matches = passphrase === again;

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (refusal || !matches) return;
        setBusy(true);
        setError(null);
        try {
            await bibleDownload(BIBLE_API.workspaceExport(workspaceSlug), 'inkquisitor-export.zip', { method: 'POST', body: { passphrase } });
            toast.success(t('done'));
            setOpen(false);
        } catch (err) {
            const reason = reasonOf(err);
            setError(reason && ['PASSPHRASE_TOO_SHORT', 'PASSPHRASE_TOO_LONG', 'PASSPHRASE_TOO_SIMPLE', 'STREAM_CAPACITY', 'EXPORT_TOO_MANY_BOOKS'].includes(reason) ? t(`errors.${reason}`) : t('errors.FAILED'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={t('title')}>
            <Modal.Form onSubmit={submit}>
                <Modal.Header title={t('title')} description={t('description')} />
                <Modal.Body className="space-y-default">
                    <FormField label={t('passphrase')} description={t('passphraseHelp', { min: PASSPHRASE_MIN_CHARS })}>
                        <Input id="workspace-export-passphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" spellCheck={false} />
                    </FormField>
                    <FormField label={t('again')}>
                        <Input id="workspace-export-passphrase-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" spellCheck={false} />
                    </FormField>
                    {passphrase !== '' && refusal ? <p className="text-sm text-content-muted" data-testid="workspace-export-hint">{t(`errors.${refusal}`)}</p> : null}
                    {passphrase !== '' && !refusal && again !== '' && !matches ? <p className="text-sm text-content-muted">{t('mismatch')}</p> : null}
                    <p className="text-sm text-content-muted">{t('warning')}</p>
                    {error ? (
                        <p className="text-sm text-content-error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </Modal.Body>
                <Modal.Actions>
                    <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                        {t('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" icon={<Archive className="size-4" aria-hidden="true" />} disabled={refusal !== null || !matches} loading={busy} id="workspace-export-submit">
                        {t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}

function DeleteWorkspaceModal({ open, setOpen, workspaceSlug, workspaceName }: { open: boolean; setOpen: Dispatch<SetStateAction<boolean>>; workspaceSlug: string; workspaceName: string }) {
    const t = useTranslations('settingsPage.yourData.deleteDialog');
    const router = useRouter();
    const [typed, setTyped] = useState('');
    const [account, setAccount] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTyped('');
        setAccount(false);
        setError(null);
    }, [open]);

    const confirmed = typed.trim() === workspaceName.trim();
    const until = formatDate(workspaceRestorableUntil(new Date()).toISOString());

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!confirmed) return;
        setBusy(true);
        setError(null);
        try {
            await bibleFetch<{ restorableUntil: string }>(BIBLE_API.workspaceDeletion(workspaceSlug), { method: 'POST', body: { confirmName: typed, deleteAccount: account } });
            // The workspace is closed now: leave it for the page that lists what can be restored.
            router.push('/no-workspace');
            router.refresh();
        } catch (err) {
            const reason = reasonOf(err);
            setError(reason && ['NAME_MISMATCH', 'ACCOUNT_HAS_OTHER_WORKSPACES'].includes(reason) ? t(`errors.${reason}`) : t('errors.FAILED'));
            setBusy(false);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={t('title', { name: workspaceName })}>
            <Modal.Form onSubmit={submit}>
                <Modal.Header title={t('title', { name: workspaceName })} description={t('description', { days: WORKSPACE_RESTORE_DAYS, date: until })} />
                <Modal.Body className="space-y-default">
                    <p className="text-sm text-content-muted">{t('exportFirst')}</p>
                    <FormField label={t('confirmLabel', { name: workspaceName })} description={t('confirmHelp')}>
                        <Input id="workspace-delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                    </FormField>
                    <label className="flex items-start gap-tight text-sm text-content-default" htmlFor="workspace-delete-account">
                        <Checkbox id="workspace-delete-account" checked={account} onCheckedChange={(v) => setAccount(v === true)} />
                        <span>{t('account')}</span>
                    </label>
                    {error ? (
                        <p className="text-sm text-content-error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </Modal.Body>
                <Modal.Actions>
                    <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                        {t('cancel')}
                    </Button>
                    <Button type="submit" variant="destructive" icon={<Trash2 className="size-4" aria-hidden="true" />} disabled={!confirmed} loading={busy} id="workspace-delete-submit">
                        {t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}

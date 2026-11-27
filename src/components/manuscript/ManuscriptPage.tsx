'use client';

/**
 * A book's manuscript (Phase 5.1, D33): the outline — parts, chapters, scenes —
 * with word counts at every level, and for an author who may edit: add, rename,
 * move (earlier / later, by keyboard as by pointer) and delete, and the import.
 *
 * One untitled part is shown as no part level at all (`singleDefaultPart`).
 * Deleting a scene goes through `useToastWithUndo` (the row hides at once and
 * the delete waits out the toast); deleting a chapter or part that holds scenes
 * first says how many go, then waits out the toast too. Refusals are worded from
 * their reasons. A reader reads the outline and opens scenes to read.
 */
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, FilePlus2, FolderPlus, Pencil, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useToastWithUndo } from '@/components/ui/hooks';
import { APP_ROUTES } from '@/lib/app-routes';
import { bibleFetch, reasonOf } from '@/lib/bible/api-client';
import { MANUSCRIPT_API, type OutlineView } from '@/lib/manuscript/api-client';
import { ImportManuscriptModal } from './ImportManuscriptModal';
import { useManuscriptReason } from './messages';

export interface ManuscriptPageProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    initial: OutlineView;
    canEdit: boolean;
}

type Level = 'part' | 'chapter' | 'scene';

interface PendingDelete {
    level: 'part' | 'chapter';
    id: string;
    title: string;
    scenes: number;
}

function InlineTitle({ id, value, placeholder, label, onSave }: { id: string; value: string | null; placeholder: string; label: string; onSave: (title: string | null) => Promise<void> }) {
    const t = useTranslations('manuscript.outline');
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value ?? '');
    if (!editing) {
        return (
            <Button variant="secondary" size="sm" icon={<Pencil className="size-4" aria-hidden="true" />} onClick={() => {
                setDraft(value ?? '');
                setEditing(true);
            }} aria-label={t('rename', { what: label })} id={`${id}-rename`} />
        );
    }
    async function submit(e: FormEvent) {
        e.preventDefault();
        await onSave(draft.trim() || null);
        setEditing(false);
    }
    return (
        <form className="flex items-center gap-tight" onSubmit={(e) => void submit(e)}>
            <Input id={`${id}-title`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} aria-label={t('titleOf', { what: label })} autoFocus />
            <Button type="submit" size="sm" variant="primary">
                {t('save')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
                {t('cancel')}
            </Button>
        </form>
    );
}

export function ManuscriptPage({ workspaceSlug, book, initial, canEdit }: ManuscriptPageProps) {
    const t = useTranslations('manuscript.outline');
    const reasonText = useManuscriptReason();
    const triggerUndo = useToastWithUndo();
    const [outline, setOutline] = useState<OutlineView>(initial);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [confirm, setConfirm] = useState<PendingDelete | null>(null);
    const slug = workspaceSlug;

    async function act<T extends { outline?: OutlineView }>(work: () => Promise<T>): Promise<T | null> {
        setBusy(true);
        try {
            const r = await work();
            if (r.outline) setOutline(r.outline);
            return r;
        } catch (err) {
            toast.error(reasonText(reasonOf(err)));
            return null;
        } finally {
            setBusy(false);
        }
    }

    const reload = () => act(() => bibleFetch<{ outline: OutlineView }>(MANUSCRIPT_API.outline(slug, book.id)));
    const addPart = () => act(() => bibleFetch<{ outline: OutlineView }>(MANUSCRIPT_API.parts(slug, book.id), { method: 'POST', body: {} }));
    const addChapter = (partId?: string) => act(() => bibleFetch<{ outline: OutlineView }>(MANUSCRIPT_API.chapters(slug, book.id), { method: 'POST', body: partId ? { partId } : {} }));
    const addScene = (chapterId: string) => act(() => bibleFetch<{ outline: OutlineView }>(MANUSCRIPT_API.scenes(slug, book.id), { method: 'POST', body: { chapterId } }));
    const rename = (level: Level, id: string, title: string | null) =>
        act(async () => {
            if (level === 'scene') return {};
            const url = level === 'part' ? MANUSCRIPT_API.part(slug, book.id, id) : MANUSCRIPT_API.chapter(slug, book.id, id);
            return bibleFetch<{ outline: OutlineView }>(url, { method: 'PATCH', body: { title } });
        }).then(() => undefined);

    function move(level: Level, id: string, parentId: string, siblings: ReadonlyArray<{ id: string }>, delta: -1 | 1) {
        const at = siblings.findIndex((s) => s.id === id);
        const target = siblings[at + delta];
        if (!target) return;
        const placement = delta < 0 ? { before: target.id } : { after: target.id };
        const url = level === 'part' ? MANUSCRIPT_API.movePart(slug, book.id, id) : level === 'chapter' ? MANUSCRIPT_API.moveChapter(slug, book.id, id) : MANUSCRIPT_API.moveScene(slug, book.id, id);
        const body = level === 'part' ? placement : level === 'chapter' ? { partId: parentId, ...placement } : { chapterId: parentId, ...placement };
        void act(() => bibleFetch<{ outline: OutlineView }>(url, { method: 'POST', body }));
    }

    function hide(id: string, on: boolean) {
        setHidden((h) => {
            const next = new Set(h);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });
    }

    function deleteWithUndo(level: Level, id: string, title: string, confirmScenes?: number) {
        hide(id, true);
        const url = level === 'part' ? MANUSCRIPT_API.part(slug, book.id, id, confirmScenes) : level === 'chapter' ? MANUSCRIPT_API.chapter(slug, book.id, id, confirmScenes) : MANUSCRIPT_API.scene(slug, book.id, id);
        triggerUndo({
            message: t(`deleted.${level}`, { title }),
            undoMessage: t('undo'),
            action: () => bibleFetch<{ outline: OutlineView }>(url, { method: 'DELETE' }),
            undoAction: () => hide(id, false),
            onCommit: (r) => {
                setOutline(r.outline);
                hide(id, false);
            },
            onError: (err) => {
                hide(id, false);
                toast.error(reasonText(reasonOf(err)));
            },
        });
    }

    const parts = outline.parts.filter((p) => !hidden.has(p.id));
    const hasChapters = parts.some((p) => p.chapters.length > 0);

    return (
        <div className="space-y-section" data-testid="manuscript-page">
            <div className="flex flex-wrap items-start justify-between gap-default">
                <div className="space-y-tight">
                    <h1 className="text-2xl font-semibold text-content-emphasis">{t('title')}</h1>
                    <p className="text-sm text-content-muted" data-testid="manuscript-totals">
                        {outline.totals.scenes === 0 ? t('notStarted') : t('totals', { words: outline.totals.words, chapters: outline.totals.chapters, scenes: outline.totals.scenes })}
                    </p>
                </div>
                {canEdit ? (
                    <div className="flex flex-wrap gap-tight">
                        <Button variant="secondary" icon={<Upload className="size-4" aria-hidden="true" />} onClick={() => setImportOpen(true)} id="manuscript-import">
                            {t('import')}
                        </Button>
                        <Button variant="secondary" icon={<FolderPlus className="size-4" aria-hidden="true" />} onClick={() => void addPart()} disabled={busy} id="manuscript-add-part">
                            {t('addPart')}
                        </Button>
                        <Button variant="primary" icon={<FilePlus2 className="size-4" aria-hidden="true" />} onClick={() => void addChapter(parts[parts.length - 1]?.id)} disabled={busy} id="manuscript-add-chapter">
                            {t('addChapter')}
                        </Button>
                    </div>
                ) : null}
            </div>

            {!hasChapters && parts.length === 0 ? (
                <EmptyState title={t('emptyTitle')} description={canEdit ? t('emptyHelp') : t('emptyReader')} />
            ) : null}

            <ol className="space-y-section" aria-label={t('outline')}>
                {parts.map((part, pi) => (
                    <li key={part.id} data-testid="manuscript-part" data-part={part.id} className="space-y-default">
                        {!outline.singleDefaultPart ? (
                            <div className="flex flex-wrap items-center justify-between gap-tight">
                                <h2 className="text-lg font-semibold text-content-emphasis">
                                    {part.title ?? t('untitledPart', { n: pi + 1 })} <span className="text-sm font-normal text-content-muted">· {t('words', { count: part.wordCount })}</span>
                                </h2>
                                {canEdit ? (
                                    <div className="flex flex-wrap items-center gap-tight">
                                        <InlineTitle id={`part-${part.id}`} value={part.title} placeholder={t('partTitlePlaceholder')} label={part.title ?? t('untitledPart', { n: pi + 1 })} onSave={(v) => rename('part', part.id, v)} />
                                        <Button variant="secondary" size="sm" icon={<ArrowUp className="size-4" aria-hidden="true" />} disabled={busy || pi === 0} onClick={() => move('part', part.id, '', parts, -1)} aria-label={t('earlier', { what: part.title ?? t('untitledPart', { n: pi + 1 }) })} />
                                        <Button variant="secondary" size="sm" icon={<ArrowDown className="size-4" aria-hidden="true" />} disabled={busy || pi === parts.length - 1} onClick={() => move('part', part.id, '', parts, 1)} aria-label={t('later', { what: part.title ?? t('untitledPart', { n: pi + 1 }) })} />
                                        <Button variant="secondary" size="sm" icon={<FilePlus2 className="size-4" aria-hidden="true" />} onClick={() => void addChapter(part.id)} disabled={busy}>
                                            {t('addChapterHere')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            icon={<Trash2 className="size-4" aria-hidden="true" />}
                                            onClick={() => {
                                                const scenes = part.chapters.reduce((n, c) => n + c.scenes.length, 0);
                                                const name = part.title ?? t('untitledPart', { n: pi + 1 });
                                                if (scenes > 0) setConfirm({ level: 'part', id: part.id, title: name, scenes });
                                                else deleteWithUndo('part', part.id, name);
                                            }}
                                            aria-label={t('delete', { what: part.title ?? t('untitledPart', { n: pi + 1 }) })}
                                        />
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        <ol className="space-y-default" aria-label={part.title ?? t('chapters')}>
                            {part.chapters.filter((c) => !hidden.has(c.id)).map((chapter, ci, chapters) => {
                                const chapterName = chapter.title ?? t('untitledChapter', { n: ci + 1 });
                                const scenes = chapter.scenes.filter((s) => !hidden.has(s.id));
                                return (
                                    <li key={chapter.id} data-testid="manuscript-chapter" data-chapter={chapter.id}>
                                        <Card className="space-y-default p-4">
                                            <div className="flex flex-wrap items-center justify-between gap-tight">
                                                <h3 className="text-base font-semibold text-content-emphasis">
                                                    {chapterName} <span className="text-sm font-normal text-content-muted">· {t('words', { count: chapter.wordCount })}</span>
                                                </h3>
                                                {canEdit ? (
                                                    <div className="flex flex-wrap items-center gap-tight">
                                                        <InlineTitle id={`chapter-${chapter.id}`} value={chapter.title} placeholder={t('chapterTitlePlaceholder')} label={chapterName} onSave={(v) => rename('chapter', chapter.id, v)} />
                                                        <Button variant="secondary" size="sm" icon={<ArrowUp className="size-4" aria-hidden="true" />} disabled={busy || ci === 0} onClick={() => move('chapter', chapter.id, part.id, chapters, -1)} aria-label={t('earlier', { what: chapterName })} />
                                                        <Button variant="secondary" size="sm" icon={<ArrowDown className="size-4" aria-hidden="true" />} disabled={busy || ci === chapters.length - 1} onClick={() => move('chapter', chapter.id, part.id, chapters, 1)} aria-label={t('later', { what: chapterName })} />
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            icon={<Trash2 className="size-4" aria-hidden="true" />}
                                                            onClick={() => (scenes.length > 0 ? setConfirm({ level: 'chapter', id: chapter.id, title: chapterName, scenes: scenes.length }) : deleteWithUndo('chapter', chapter.id, chapterName))}
                                                            aria-label={t('delete', { what: chapterName })}
                                                        />
                                                    </div>
                                                ) : null}
                                            </div>
                                            {scenes.length === 0 ? <p className="text-sm text-content-muted">{t('noScenes')}</p> : null}
                                            <ol className="divide-y divide-[var(--border-subtle)]" aria-label={t('scenesOf', { chapter: chapterName })}>
                                                {scenes.map((scene, si) => {
                                                    const sceneName = scene.title ?? t('untitledScene', { n: si + 1 });
                                                    return (
                                                        <li key={scene.id} className="flex flex-wrap items-center justify-between gap-tight py-2" data-testid="manuscript-scene" data-scene={scene.id}>
                                                            <Link href={APP_ROUTES.scene(slug, book.id, scene.id)} className="text-sm font-medium text-content-brand hover:underline">
                                                                {sceneName}
                                                            </Link>
                                                            <div className="flex items-center gap-tight">
                                                                <span className="text-xs text-content-muted">{t('words', { count: scene.wordCount })}</span>
                                                                {canEdit ? (
                                                                    <>
                                                                        <Button variant="secondary" size="sm" icon={<ArrowUp className="size-4" aria-hidden="true" />} disabled={busy || si === 0} onClick={() => move('scene', scene.id, chapter.id, scenes, -1)} aria-label={t('earlier', { what: sceneName })} />
                                                                        <Button variant="secondary" size="sm" icon={<ArrowDown className="size-4" aria-hidden="true" />} disabled={busy || si === scenes.length - 1} onClick={() => move('scene', scene.id, chapter.id, scenes, 1)} aria-label={t('later', { what: sceneName })} />
                                                                        <Button variant="secondary" size="sm" icon={<Trash2 className="size-4" aria-hidden="true" />} onClick={() => deleteWithUndo('scene', scene.id, sceneName)} aria-label={t('delete', { what: sceneName })} />
                                                                    </>
                                                                ) : null}
                                                            </div>
                                                        </li>
                                                    );
                                                })}
                                            </ol>
                                            {canEdit ? (
                                                <Button variant="secondary" size="sm" icon={<FilePlus2 className="size-4" aria-hidden="true" />} onClick={() => void addScene(chapter.id)} disabled={busy} aria-label={t('addSceneTo', { chapter: chapterName })}>
                                                    {t('addScene')}
                                                </Button>
                                            ) : null}
                                        </Card>
                                    </li>
                                );
                            })}
                        </ol>
                    </li>
                ))}
            </ol>

            {confirm ? (
                <Modal
                    showModal
                    setShowModal={(v) => {
                        if (!(typeof v === 'function' ? v(true) : v)) setConfirm(null);
                    }}
                    title={t('confirmTitle', { title: confirm.title })}
                >
                    <Modal.Header title={t('confirmTitle', { title: confirm.title })} description={t(`confirmHelp.${confirm.level}`, { scenes: confirm.scenes })} />
                    <Modal.Actions>
                        <Button type="button" variant="secondary" onClick={() => setConfirm(null)}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            icon={<Trash2 className="size-4" aria-hidden="true" />}
                            onClick={() => {
                                const c = confirm;
                                setConfirm(null);
                                deleteWithUndo(c.level, c.id, c.title, c.scenes);
                            }}
                            id="manuscript-confirm-delete"
                        >
                            {t('confirmDelete', { scenes: confirm.scenes })}
                        </Button>
                    </Modal.Actions>
                </Modal>
            ) : null}

            {canEdit ? <ImportManuscriptModal open={importOpen} setOpen={setImportOpen} workspaceSlug={slug} bookId={book.id} onImported={() => void reload()} /> : null}
        </div>
    );
}

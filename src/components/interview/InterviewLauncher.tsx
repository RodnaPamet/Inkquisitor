'use client';

/**
 * Where an interview starts (Phase 2.4): "Enrich" on an element, "Grill me"
 * on a kind's card or on the book. A button that opens the setup sheet
 * (`InterviewSetupSheet`). Rendered only for a viewer who may edit the bible
 * (`bible.edit`): the page decides, never a role read here.
 */
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { InterviewTarget } from '@/lib/interview/setup';
import { InterviewSetupSheet } from './InterviewSetupSheet';

export interface InterviewLauncherProps {
    workspaceSlug: string;
    bookId: string;
    target: InterviewTarget;
    /** The sheet's title. */
    title: string;
    label: ReactNode;
    icon?: ReactNode;
    size?: 'sm';
    disabled?: boolean;
    disabledTooltip?: string;
    'aria-label'?: string;
    id?: string;
    'data-testid'?: string;
}

export function InterviewLauncher({ workspaceSlug, bookId, target, title, label, icon, size, disabled, disabledTooltip, id, ...rest }: InterviewLauncherProps) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                variant="secondary"
                size={size}
                icon={icon}
                onClick={() => setOpen(true)}
                disabledTooltip={disabled ? disabledTooltip : undefined}
                aria-label={rest['aria-label']}
                id={id}
                data-testid={rest['data-testid']}
            >
                {label}
            </Button>
            {open ? <InterviewSetupSheet open={open} setOpen={setOpen} workspaceSlug={workspaceSlug} bookId={bookId} target={target} title={title} /> : null}
        </>
    );
}

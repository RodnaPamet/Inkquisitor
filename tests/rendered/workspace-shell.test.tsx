/**
 * <WorkspaceShell> — the canvas page shell.
 *
 * No inflect-compliance suite exists for it, so this one is new. The shell is
 * layout only: a root column with optional header and toolbar slots that do
 * not grow, and a body that fills the rest and clips (the canvas inside owns
 * pan and scroll). Each slot carries its marker and the caller's classes.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { WorkspaceShell } from '@/components/layout/WorkspaceShell';

describe('<WorkspaceShell>', () => {
    it('lays out header, toolbar and a filling, clipping body in order', () => {
        const { container } = render(
            <WorkspaceShell className="h-96">
                <WorkspaceShell.Header>
                    <h1>Story canvas</h1>
                </WorkspaceShell.Header>
                <WorkspaceShell.Toolbar>
                    <button type="button">Fit</button>
                </WorkspaceShell.Toolbar>
                <WorkspaceShell.Body>
                    <div>Canvas surface</div>
                </WorkspaceShell.Body>
            </WorkspaceShell>,
        );
        const root = container.querySelector('[data-workspace-shell="true"]')!;
        expect(root).toHaveClass('h-96', 'flex-col');
        const [header, toolbar, body] = Array.from(root.children);
        expect(header.tagName).toBe('HEADER');
        expect(header).toHaveClass('flex-shrink-0');
        expect(toolbar).toHaveAttribute('data-workspace-toolbar', 'true');
        expect(toolbar).toHaveClass('flex-shrink-0');
        expect(body).toHaveAttribute('data-workspace-body', 'true');
        expect(body).toHaveClass('md:flex-1', 'md:overflow-hidden');
        expect(screen.getByRole('heading', { name: 'Story canvas' })).toBeInTheDocument();
        expect(screen.getByText('Canvas surface')).toBeInTheDocument();
    });

    it('the toolbar is optional', () => {
        const { container } = render(
            <WorkspaceShell>
                <WorkspaceShell.Body>
                    <div>Canvas surface</div>
                </WorkspaceShell.Body>
            </WorkspaceShell>,
        );
        expect(container.querySelector('[data-workspace-toolbar]')).toBeNull();
        expect(container.querySelector('[data-workspace-body]')).not.toBeNull();
    });
});

/**
 * `WorkspaceContext` — the contract subphase 0.3 builds against.
 *
 * 0.3 replaces what feeds the provider; it must not have to change a
 * consumer. So this suite pins the behaviour of the exported surface:
 * `useWorkspace()` returns the provided value and throws without one,
 * `useOptionalWorkspace()` returns the value or `null`, and the role is
 * exactly OWNER / EDITOR / READER (owner decision D4).
 */
import { render, renderHook, screen } from '@testing-library/react';
import * as React from 'react';
import {
    WorkspaceProvider,
    useOptionalWorkspace,
    useWorkspace,
    type WorkspaceContextValue,
    type WorkspaceRole,
} from '@/lib/workspace/workspace-context';
import * as workspaceModule from '@/lib/workspace/workspace-context';

const VALUE: WorkspaceContextValue = {
    workspaceId: 'ws_1',
    workspaceSlug: 'ada',
    workspaceName: "Ada's books",
    role: 'OWNER',
    userId: 'user_1',
    userName: 'Ada Quill',
};

function withValue(value: WorkspaceContextValue | null) {
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return <WorkspaceProvider value={value}>{children}</WorkspaceProvider>;
    };
}

describe('WorkspaceContext', () => {
    it('exports exactly the five names 0.3 relies on (values; the two types are erased)', () => {
        expect(Object.keys(workspaceModule).sort()).toEqual(['WorkspaceProvider', 'useOptionalWorkspace', 'useWorkspace']);
    });

    it('useWorkspace returns the provided value', () => {
        const { result } = renderHook(() => useWorkspace(), { wrapper: withValue(VALUE) });
        expect(result.current).toEqual(VALUE);
    });

    it('useWorkspace throws outside any provider', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => renderHook(() => useWorkspace())).toThrow(/useWorkspace\(\) was called with no workspace/);
        spy.mockRestore();
    });

    it('useWorkspace throws inside a provider whose value is null (signed out)', () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => renderHook(() => useWorkspace(), { wrapper: withValue(null) })).toThrow(/no workspace/);
        spy.mockRestore();
    });

    it('useOptionalWorkspace returns the value, null when signed out, null outside a provider', () => {
        expect(renderHook(() => useOptionalWorkspace(), { wrapper: withValue(VALUE) }).result.current).toEqual(VALUE);
        expect(renderHook(() => useOptionalWorkspace(), { wrapper: withValue(null) }).result.current).toBeNull();
        expect(renderHook(() => useOptionalWorkspace()).result.current).toBeNull();
    });

    it('an inner provider overrides an outer one', () => {
        function Name() {
            return <span data-testid="name">{useOptionalWorkspace()?.workspaceName ?? 'none'}</span>;
        }
        render(
            <WorkspaceProvider value={VALUE}>
                <WorkspaceProvider value={null}>
                    <Name />
                </WorkspaceProvider>
            </WorkspaceProvider>,
        );
        expect(screen.getByTestId('name').textContent).toBe('none');
    });

    it('the role type is exactly OWNER | EDITOR | READER', () => {
        const roles: Record<WorkspaceRole, true> = { OWNER: true, EDITOR: true, READER: true };
        expect(Object.keys(roles)).toEqual(['OWNER', 'EDITOR', 'READER']);
    });
});

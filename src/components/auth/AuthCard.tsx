import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/**
 * The frame every signed-out page uses (sign in, sign up, sign out, no
 * workspace): a centred card under the product name. Layout only.
 */
export function AuthCard({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id: string }) {
    return (
        <main id={id} className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-default px-6 py-page">
            <Card className="space-y-default p-6">
                <div className="space-y-tight">
                    <h1 className="text-2xl font-semibold tracking-tight text-content-emphasis">{title}</h1>
                    {description ? <p className="text-sm text-content-muted">{description}</p> : null}
                </div>
                {children}
            </Card>
        </main>
    );
}

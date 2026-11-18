import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/product';

export default function HomePage() {
    return (
        <main id="home" className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
            <h1 className="text-5xl font-bold tracking-tight">{PRODUCT_NAME}</h1>
            <p className="text-lg text-stone-600">{PRODUCT_DESCRIPTION}</p>
        </main>
    );
}

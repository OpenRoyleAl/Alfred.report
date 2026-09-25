import { BRIEF_META, COVER_DECK } from "@/lib/brief/content";

export function Cover() {
  return (
    <header className="border-b border-rule pb-12 pt-4 sm:pb-16">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-muted">
        <span>{BRIEF_META.classification}</span>
        <span className="hidden h-3 w-px bg-rule-strong sm:block" aria-hidden />
        <span>{BRIEF_META.date}</span>
        <span className="hidden h-3 w-px bg-rule-strong sm:block" aria-hidden />
        <span>{BRIEF_META.id}</span>
      </p>

      <h1 className="mt-8 font-display text-[2.75rem] leading-[0.95] tracking-[-0.03em] text-ink sm:text-6xl md:text-7xl">
        {BRIEF_META.title}
      </h1>
      <p className="mt-5 max-w-xl font-display text-xl leading-snug text-ink-2 sm:text-2xl">
        {BRIEF_META.subtitle}
      </p>

      <div className="mt-10 max-w-2xl space-y-4">
        {COVER_DECK.map((p) => (
          <p key={p.slice(0, 32)} className="text-base leading-relaxed text-ink-2">
            {p}
          </p>
        ))}
      </div>

      <dl className="mt-10 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted">
            Replaces
          </dt>
          <dd className="mt-1 text-sm text-ink">{BRIEF_META.replaces}</dd>
        </div>
        <div>
          <dt className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted">
            Status
          </dt>
          <dd className="mt-1 text-sm text-ink">{BRIEF_META.status}</dd>
        </div>
      </dl>
    </header>
  );
}

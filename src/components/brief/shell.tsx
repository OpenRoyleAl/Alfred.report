import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { BRIEF_META, CHAPTERS, briefToMarkdown } from "@/lib/brief/content";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/components/brief/blocks";
import { Cover } from "@/components/brief/cover";
import { DesktopNav, MobileNav } from "@/components/brief/nav";

export function BriefShell() {
  const [activeId, setActiveId] = useState(CHAPTERS[0].id);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const nodes = CHAPTERS.map((ch) => document.getElementById(ch.id)).filter(
      (el): el is HTMLElement => Boolean(el),
    );
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveId(visible[0].target.id);
      },
      { rootMargin: "0px 0px -62% 0px", threshold: 0.05 },
    );
    for (const n of nodes) observer.observe(n);
    return () => observer.disconnect();
  }, []);

  function jump(id: string) {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  }

  async function copyBrief() {
    await navigator.clipboard.writeText(briefToMarkdown());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <div className="border-b border-rule bg-ink text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-paper/70">
            {BRIEF_META.id} · Command constitution
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={copyBrief}
            className="text-paper hover:bg-white/10"
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy markdown"}
          </Button>
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl gap-10 px-5 pb-24 pt-6 lg:pt-10">
        <aside className="sticky top-6 hidden h-[calc(100dvh-3rem)] overflow-y-auto lg:block">
          <DesktopNav activeId={activeId} onJump={jump} />
        </aside>

        <article className="min-w-0 flex-1">
          <MobileNav activeId={activeId} onJump={jump} />
          <Cover />

          <div className="mt-16 flex flex-col gap-20">
            {CHAPTERS.map((ch) => (
              <section
                key={ch.id}
                id={ch.id}
                className="scroll-mt-20"
                aria-labelledby={`${ch.id}-title`}
              >
                <p className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted">
                  {ch.num} · {ch.kicker}
                </p>
                <h2
                  id={`${ch.id}-title`}
                  className="mt-2 font-display text-4xl leading-tight tracking-[-0.02em] text-ink sm:text-5xl"
                >
                  {ch.title}
                </h2>
                <div className="mt-8">
                  <Blocks blocks={ch.blocks} />
                </div>
              </section>
            ))}
          </div>

          <footer className="mt-20 border-t border-rule pt-8">
            <p className="font-display text-lg text-ink-2">
              Build the kernel. Close one mission. Then — and only then — staff.
            </p>
            <p className="mt-3 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted">
              End of {BRIEF_META.id}
            </p>
          </footer>
        </article>
      </div>
    </div>
  );
}

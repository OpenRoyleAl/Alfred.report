import { CHAPTERS } from "@/lib/brief/content";
import { cn } from "@/lib/utils";

export function DesktopNav({
  activeId,
  onJump,
}: {
  activeId: string;
  onJump: (id: string) => void;
}) {
  return (
    <nav aria-label="Chapters" className="flex w-56 shrink-0 flex-col gap-1 pt-2">
      {CHAPTERS.map((ch) => (
        <button
          key={ch.id}
          type="button"
          onClick={() => onJump(ch.id)}
          className={cn(
            "flex min-h-11 items-baseline gap-3 rounded-md px-3 py-2 text-left transition-colors duration-150",
            activeId === ch.id ? "bg-paper-2 text-ink" : "text-muted hover:text-ink",
          )}
        >
          <span className="font-mono text-[0.7rem] tabular-nums">{ch.num}</span>
          <span className="font-sans text-sm">{ch.title}</span>
        </button>
      ))}
    </nav>
  );
}

export function MobileNav({
  activeId,
  onJump,
}: {
  activeId: string;
  onJump: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Chapters"
      className="sticky top-0 z-20 -mx-5 mb-8 border-b border-rule bg-paper/95 px-5 py-2 backdrop-blur-sm lg:hidden"
    >
      <div className="flex gap-1 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CHAPTERS.map((ch) => (
          <button
            key={ch.id}
            type="button"
            onClick={() => onJump(ch.id)}
            className={cn(
              "flex h-11 shrink-0 items-center gap-2 rounded-md px-3 font-sans text-sm transition-colors duration-150",
              activeId === ch.id ? "bg-ink text-paper" : "text-muted",
            )}
          >
            <span className="font-mono text-[0.7rem] tabular-nums">{ch.num}</span>
            <span>{ch.title}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

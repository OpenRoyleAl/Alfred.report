import type { Block } from "@/lib/brief/content";
import { cn } from "@/lib/utils";

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="flex flex-col gap-6">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "lede":
      return (
        <p className="font-display text-xl leading-snug text-ink italic sm:text-2xl">
          {block.text}
        </p>
      );
    case "p":
      return (
        <p className="text-base leading-relaxed text-ink-2">{block.text}</p>
      );
    case "h3":
      return (
        <h3 className="mt-4 font-sans text-xs font-medium uppercase tracking-[0.16em] text-muted">
          {block.text}
        </h3>
      );
    case "list":
      return (
        <ul className="flex flex-col gap-3">
          {block.items.map((item) => (
            <li
              key={item.slice(0, 48)}
              className="grid grid-cols-[12px_1fr] gap-3 text-base leading-relaxed text-ink-2"
            >
              <span className="mt-[0.7em] h-px w-2 bg-rule-strong" aria-hidden />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
    case "table":
      return <BriefTable headers={block.headers} rows={block.rows} />;
    case "callout":
      return (
        <aside
          className={cn(
            "rounded-lg px-5 py-4",
            block.kind === "kill" && "bg-ink text-paper",
            block.kind === "law" && "bg-law text-paper",
            block.kind === "proof" && "bg-forest text-forest-fg",
          )}
        >
          <p className="font-sans text-[0.7rem] font-medium uppercase tracking-[0.18em] opacity-70">
            {block.kind} — {block.title}
          </p>
          <p className="mt-2 font-display text-lg leading-snug">{block.body}</p>
        </aside>
      );
    case "code":
      return (
        <figure className="overflow-hidden rounded-lg bg-ink text-paper">
          <figcaption className="border-b border-white/10 px-4 py-2 font-mono text-[0.7rem] tracking-wide text-paper/60">
            {block.label}
          </figcaption>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-[0.78rem] leading-relaxed">
            <code>{block.code}</code>
          </pre>
        </figure>
      );
    case "principles":
      return (
        <ol className="flex flex-col gap-8">
          {block.items.map((item) => (
            <li key={item.n} className="grid gap-2 sm:grid-cols-[3.5rem_1fr] sm:gap-6">
              <span className="font-display text-3xl leading-none text-faint">{item.n}</span>
              <div>
                <h3 className="font-sans text-base font-medium text-ink">{item.title}</h3>
                <p className="mt-2 text-base leading-relaxed text-ink-2">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      );
    case "days":
      return (
        <ol className="flex flex-col gap-8">
          {block.items.map((day) => (
            <li key={day.day} className="rounded-xl bg-paper-2 p-5 sm:p-6">
              <p className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-muted">
                Day {day.day}
              </p>
              <h3 className="mt-1 font-display text-2xl text-ink">{day.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{day.why}</p>
              <ul className="mt-4 flex flex-col gap-2">
                {day.items.map((item) => (
                  <li
                    key={item.slice(0, 40)}
                    className="grid grid-cols-[12px_1fr] gap-3 text-sm leading-relaxed text-ink-2"
                  >
                    <span className="mt-[0.65em] h-px w-2 bg-rule-strong" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      );
    case "stack":
      return (
        <ol className="flex flex-col">
          {block.layers.map((layer, i) => (
            <li
              key={layer.name}
              className="grid gap-1 border-t border-rule py-4 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-6"
            >
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[0.65rem] text-faint">
                  {String(i).padStart(2, "0")}
                </span>
                <span className="font-sans text-sm font-medium text-ink">{layer.name}</span>
              </div>
              <p className="text-sm leading-relaxed text-ink-2">{layer.detail}</p>
            </li>
          ))}
          <li className="border-t border-rule" aria-hidden />
        </ol>
      );
  }
}

function BriefTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-rule-strong">
            {headers.map((h) => (
              <th
                key={h}
                className="px-3 py-3 font-sans text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-rule align-top">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-3 py-3 leading-relaxed text-ink-2",
                    j === 0 && "font-medium text-ink",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";

export interface SegmentOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly hint: string;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** A row of mutually exclusive choices with the active option's hint below. */
export function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const active = options.find((o) => o.value === value);
  return (
    <div className="flex items-start gap-3">
      <span className="mt-2 w-20 shrink-0 text-xs text-slate-400">{label}</span>
      <div className="min-w-0 flex-1">
        <div
          role="radiogroup"
          aria-label={label}
          className="grid gap-1 rounded-lg border border-white/[0.08] bg-[#0B0F17] p-1"
          style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={String(option.value)}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onChange(option.value)}
                title={option.hint}
                className={cx(
                  "h-8 rounded-md font-mono text-xs tracking-wide transition-all",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? "bg-indigo-500/25 text-indigo-100 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.55),0_0_14px_-4px_rgba(129,140,248,0.7)]"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {active && <p className="mt-1 text-[10px] text-slate-500">{active.hint}</p>}
      </div>
    </div>
  );
}

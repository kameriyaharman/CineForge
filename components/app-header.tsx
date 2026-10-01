"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Aperture, Clapperboard, Fingerprint, FolderOpen, ImageIcon } from "lucide-react";
import { AccountControl, TestModeBanner } from "@/components/account-control";

const NAV = [
  { href: "/soul-id", label: "Soul ID", icon: Fingerprint },
  { href: "/images", label: "Images", icon: ImageIcon },
  { href: "/video", label: "Video", icon: Clapperboard },
  { href: "/library", label: "Library", icon: FolderOpen },
] as const;

/** Top bar shared by every signed-in page. `status` renders on the right. */
export function AppHeader({ status }: { status?: ReactNode }) {
  const pathname = usePathname();
  return (
    <>
    <header className="relative z-20 border-b border-white/[0.06] bg-[#0B0F17]/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg border border-indigo-400/40 bg-indigo-500/10 shadow-[0_0_20px_-4px_rgba(129,140,248,0.6)]">
              <Aperture className="size-5 text-indigo-300" aria-hidden />
            </span>
            <span className="hidden text-lg font-semibold tracking-tight sm:inline">
              Cine<span className="text-indigo-300">Forge</span>
            </span>
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active =
                href === "/video" ? pathname === "/" || pathname.startsWith("/video") : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={
                    "flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:px-3 " +
                    (active
                      ? "bg-indigo-500/15 text-indigo-100 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.35)]"
                      : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200")
                  }
                >
                  <Icon className="size-4" aria-hidden />
                  <span className="sr-only md:not-sr-only">{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {status && (
            <div className="hidden items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-slate-500 xl:flex">
              {status}
            </div>
          )}
          <AccountControl />
        </div>
      </div>
    </header>
    <TestModeBanner />
    </>
  );
}

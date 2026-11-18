"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/practice", label: "練習する" },
  { href: "/history", label: "履歴" },
  { href: "/wordbook", label: "単語帳" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </>
  );
}

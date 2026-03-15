"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface ContractTabNavProps {
  contractId: string;
}

export function ContractTabNav({ contractId }: ContractTabNavProps) {
  const pathname = usePathname();

  const tabs = [
    { label: "구역 분류", href: `/contracts/${contractId}/zones` },
    { label: "조항 분석", href: `/contracts/${contractId}` },
    { label: "리포트", href: `/contracts/${contractId}/report` },
  ];

  return (
    <nav className="flex border-b border-border bg-bg-secondary px-8">
      {tabs.map((tab) => {
        const isActive =
          tab.href === `/contracts/${contractId}`
            ? pathname === tab.href
            : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`border-b-2 px-5 py-3 text-[13px] font-medium transition-colors ${
              isActive
                ? "border-accent-blue text-accent-blue"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

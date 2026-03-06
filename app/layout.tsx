import React from "react";
import "./globals.css";
import { AppShell } from "../components/layout/AppShell";

export const metadata = {
  title: "ContractLens — Contract Risk Review",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

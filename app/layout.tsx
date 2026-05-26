import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "42.space Market Dashboard",
  description: "Public growth, capital flow, and market quality dashboard for 42.space.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

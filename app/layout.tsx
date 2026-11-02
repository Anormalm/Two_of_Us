import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "两个人",
  description: "一个简约、私密的双人共同生活空间。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}

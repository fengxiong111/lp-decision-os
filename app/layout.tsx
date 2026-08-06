import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LP Alpha Terminal · RWA Liquidity Intelligence",
  description: "输入投入金额和预测窗口，获得可执行、可解释的 RWA 流动性决策。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

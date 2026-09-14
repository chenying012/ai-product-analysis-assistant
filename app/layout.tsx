import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "品析 · AI 产品分析助手",
  description: "从 Amazon 商品链接，整理产品信息、理解用户场景，并生成中文短视频口播文案。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

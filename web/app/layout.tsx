import type { Metadata, Viewport } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Talk with Masahiro — AIアバター英会話コーチ",
    template: "%s | Talk with Masahiro",
  },
  description:
    "リアルタイムに話せるAIアバターの英会話コーチ。教わった単語はカードで画面に表示され、単語帳に自動保存されます。",
};

export const viewport: Viewport = {
  themeColor: "#0b0d12",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

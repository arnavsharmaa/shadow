import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { TopNav } from "@/components/ui/TopNav";

export const metadata: Metadata = {
  title: "Shadow",
  description: "Time-travel debugging for AI agents.",
};

const themeScript = `(function(){try{var t=localStorage.getItem("shadow-theme");if(!t){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex h-screen flex-col overflow-hidden">
        <Providers>
          <TopNav />
          <main className="min-h-0 flex-1">{children}</main>
        </Providers>
      </body>
    </html>
  );
}

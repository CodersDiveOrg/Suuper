import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Automation Platform",
  description: "Tenant dashboard for bots, MCP servers, and knowledge bases",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

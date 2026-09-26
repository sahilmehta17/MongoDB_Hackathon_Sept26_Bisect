import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bisect",
  description: "Find, verify and remove the lesson that broke your self-improving agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

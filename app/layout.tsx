import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TickerQuest Family Game Service",
  description:
    "The shared game service behind the private TickerQuest family league.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

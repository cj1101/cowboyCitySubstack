import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { FactionProvider } from "@/components/factions/FactionContext";
import { NavBar } from "@/components/layout/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cowboy City Lore",
  description: "Private lore social network for the Cowboy City Minecraft realm",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>
          <FactionProvider>
            <NavBar />
            <main className="pt-14 sm:pt-16">{children}</main>
          </FactionProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

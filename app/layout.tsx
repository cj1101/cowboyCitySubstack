import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { FactionProvider } from "@/components/factions/FactionContext";
import { MembershipGate } from "@/components/auth/MembershipGate";
import { NavBar } from "@/components/layout/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cowboy City Lore",
  description: "Private multimedia chronicle for the realm's city-states",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{ backgroundColor: "#2a1a0f" }}>
      <body className="antialiased" style={{ backgroundColor: "#2a1a0f", color: "#f5e6d3" }}>
        <AuthProvider>
          <FactionProvider>
            <NavBar />
            <main className="pt-14 sm:pt-16">
              <MembershipGate>{children}</MembershipGate>
            </main>
          </FactionProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

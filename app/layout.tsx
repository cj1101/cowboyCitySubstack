import type { Metadata, Viewport } from "next";
import "@fontsource/press-start-2p/latin-400.css";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { FactionProvider } from "@/components/factions/FactionContext";
import { MembershipGate } from "@/components/auth/MembershipGate";
import { NavBar } from "@/components/layout/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cowboy City & The Realm",
  description: "Private multimedia chronicle for the realm's city-states",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{ backgroundColor: "#f7f6f3" }}>
      <body className="antialiased" style={{ backgroundColor: "#f7f6f3", color: "#3f3d39" }}>
        <AuthProvider>
          <FactionProvider>
            <NavBar />
            <main className="app-main">
              <MembershipGate>{children}</MembershipGate>
            </main>
          </FactionProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

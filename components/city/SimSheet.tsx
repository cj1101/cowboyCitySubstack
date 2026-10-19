/**
 * components/city/SimSheet.tsx — the module map's named path for the
 * per-city sim sheet (Phase 3 brief §1.1/§6.1).
 *
 * The component itself is Ines' stat-sheets module work and lives at
 * components/stats/SimSheet.tsx; this file re-exports it so the city
 * page section and the dashboard my-city panel's `sheet` variant
 * render the IDENTICAL component (TC-D01 by construction — one
 * component, two mounts, never two implementations).
 */
export { default } from "@/components/stats/SimSheet";
export { SimSheetView } from "@/components/stats/SimSheet";

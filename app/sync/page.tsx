import SyncStudio from "@/components/SyncStudio";
import catalog from "@/data/catalog.json";
import type { Catalog } from "@/lib/types";

export const dynamic = "force-static";

export const metadata = {
  title: "Sync studio — Ghazal for Gen Z",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <SyncStudio catalog={catalog as unknown as Catalog} />;
}

import SyncStudio from "@/components/SyncStudio";
import { syncCatalog } from "@/lib/catalog";
import catalog from "@/data/catalog.json";
import type { Catalog } from "@/lib/types";

export const dynamic = "force-static";

export const metadata = {
  title: "Sync studio",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <SyncStudio catalog={syncCatalog(catalog as unknown as Catalog)} />;
}

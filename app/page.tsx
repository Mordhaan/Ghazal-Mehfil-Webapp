import GhazalStage from "@/components/GhazalStage";
import catalog from "@/data/catalog.json";
import type { Catalog } from "@/lib/types";

export const dynamic = "force-static";

export default function Page() {
  return <GhazalStage catalog={catalog as unknown as Catalog} />;
}

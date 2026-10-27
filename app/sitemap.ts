import type { MetadataRoute } from "next";
import catalog from "@/data/catalog.json";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const generated = (catalog as { generated?: string }).generated;
  const lastModified = generated && !Number.isNaN(Date.parse(generated)) ? new Date(generated) : new Date();

  return [
    {
      url: `${siteUrl()}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}

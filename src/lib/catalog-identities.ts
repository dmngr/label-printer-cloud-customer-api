import type { CatalogProductLookup, CatalogTemplateLookup } from "../types";

export interface CatalogIdentityAttributeValue {
  S?: string;
  N?: string;
}

type CatalogIdentityItem = Record<string, CatalogIdentityAttributeValue>;

function readString(item: CatalogIdentityItem, key: string): string {
  const value = item[key]?.S;
  return typeof value === "string" ? value : "";
}

function readNumber(item: CatalogIdentityItem, key: string): number {
  const value = item[key]?.N;
  if (typeof value !== "string") return 0;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toCatalogProductIdentity(item: CatalogIdentityItem): CatalogProductLookup {
  return {
    // Id is the global DynamoDB row key. Device commands must use the local id.
    id: readNumber(item, "LocalProductId"),
    code: readString(item, "Code"),
    name: readString(item, "Name")
  };
}

export function toCatalogTemplateIdentity(item: CatalogIdentityItem): CatalogTemplateLookup {
  return {
    // Never fall back to Id: it may target an unrelated local template.
    id: readNumber(item, "LocalTemplateId"),
    code: readString(item, "Code"),
    name: readString(item, "Name")
  };
}

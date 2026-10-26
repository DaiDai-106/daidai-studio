import type { JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { defineDocFamily, type Harness } from "@earendil-works/pi-durable";

type Catalog = { value: JsonRepresentation<ModelsStoreEntry> | null };
const CatalogDoc = defineDocFamily<Catalog, null>({
  kind: "app.modelCatalog",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ value: null }),
});
export function createCatalogStore(harness: () => Harness): ModelsStore {
  return {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      const state = await harness().snapshot(CatalogDoc, id, context);
      return state?.value ?? undefined;
    },
    async write(id, entry, options) {
      options?.signal?.throwIfAborted();
      const value: JsonRepresentation<ModelsStoreEntry> = JSON.parse(JSON.stringify(entry));
      await harness().commit(async (tx) => {
        (await tx.doc(CatalogDoc, id, null)).value = value;
      }, context);
    },
    async delete(id, options) {
      options?.signal?.throwIfAborted();
      await harness().commit(async (tx) => {
        await tx.retireDoc(CatalogDoc, id);
      }, context);
    },
  };
}

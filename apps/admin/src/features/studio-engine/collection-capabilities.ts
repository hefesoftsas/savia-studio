import {
  usesNativeRecordStorage,
  type CollectionCapabilities,
  type StudioObject,
} from "@savia/studio-shared/metadata";
export type { CollectionCapabilities } from "@savia/studio-shared/metadata";
const local: CollectionCapabilities = {
  list: true,
  read: true,
  create: true,
  update: true,
  delete: true,
  restore: true,
  schema: true,
  customFields: true,
};
export function collectionCapabilities(
  object: StudioObject,
): CollectionCapabilities {
  const studio = object.config.studio;
  if (
    studio?.collection?.kind === "domain" &&
    studio.collection.domain === "agency-network" &&
    studio.collection.collection === "agency-profiles"
  )
    return {
      ...(studio.capabilities ?? studio.collection.capabilities),
      filter: true,
      sort: true,
    };
  if (studio?.capabilities) return studio.capabilities;
  if (studio?.collection) return studio.collection.capabilities;
  if (studio?.business === "managed-agency")
    return { ...local, delete: false, schema: false };
  if (studio?.business === "managed-customer")
    return { ...local, schema: false };
  return local;
}
/** Trash, import and other tooling for collections without scoped capabilities. */
export function supportsLocalRecordTools(object: StudioObject): boolean {
  return usesNativeRecordStorage(object) && !object.config.studio?.capabilities;
}

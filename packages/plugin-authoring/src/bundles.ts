export type AuthoringBundles<Bundle = string> = {
  runtimeBundle: Bundle;
  vendorBundles: Record<string, Bundle>;
};

type BundleSource = string | (() => Promise<string>);
export type AuthoringBundleSources = AuthoringBundles<BundleSource>;

export async function resolveAuthoringBundle(source: BundleSource) {
  return typeof source === "function" ? source() : source;
}

import type { Flow } from "./types";

export const sampleBundleFlows: Flow[] = [
  "sample-provider-lookup",
  "sample-provider-request",
].map((id) => ({
  id,
  name: id,
  description: "Bundled example request",
  input: {},
  variables: [
    { key: "endpoint", value: "https://provider.test", secret: false },
  ],
  steps: [
    {
      id: "request",
      name: "Request",
      method: "GET",
      url: "{{endpoint}}",
      headers: {},
      body: "",
      pre: "",
      post: "",
      sourcePath: `Examples/Providers/${id}`,
    },
  ],
}));

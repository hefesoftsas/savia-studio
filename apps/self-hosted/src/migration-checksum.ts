// Only these exact, schema-identical revisions can coexist in a migration
// history. All other migrations require exact bytes.
const bootstrapChecksumGroups = [
  new Set([
    "ca8b29773ea7b86e43522c94a6b9bc4840605ad739e792c3f3a9ffacc13feb83",
    "c73cb84bea0fd0316de37a2488154f2e53c83dcbce6d5a4eca8ed5f5416be62a",
    "04d93ce00c56a071966e17b526e8457cb649c80e3b8a881933d4b76a1b713a36",
  ]),
  new Set([
    "aedf9f46d171ccbacadde397f2ecf353dc4619999ded4ad3429a687618860804",
    "619a10b18128cac4811fa4318e1b072eb3a1404f7a137ff66ebe18e7e2673f3d",
    "d0fea3ff497bd8dee56f4c58079dccb31c82f29872d929a7ca15dc8661ac9c72",
  ]),
];
const postgresMigrationChecksumGroups = [
  {
    filename: "0048_mcp_collection_sources.sql",
    checksums: new Set([
      "eade1a5f6442d75f164eea7fcc88fcfc690671ac2c3c67a25b4b561ba893bd2e",
      "c3ee0122ef8a7b0aaa444f6dbbc3bbb91643b194483e4818d4a66c84f9142c53",
    ]),
  },
  {
    filename: "0057_savia_flows_collection_events.sql",
    checksums: new Set([
      "35aa3bd9d34a2b1f73e704b3f88cb70bcdb699ce9111eca8206a70a30593ade0",
      "b8cddd79e880370b55875bdf81ff1ebd42193745cf0c107bb9ca36827220a9e7",
    ]),
  },
  {
    filename: "0058_savia_flows_native_causation.sql",
    checksums: new Set([
      "b358d11b71f37983bbae64bdc8b764281bd1973b8f1996fc99ef918d41f76a92",
      "5f4ef047bf69392003eee30497692a04dd8eb5fa32a2aeeb1975a04022e56922",
    ]),
  },
];

export function migrationChecksumMatches(
  filename: string,
  expected: string,
  observed: unknown,
): boolean {
  return (
    observed === expected ||
    (filename === "0002_bootstrap.sql" &&
      typeof observed === "string" &&
      bootstrapChecksumGroups.some(
        (group) => group.has(expected) && group.has(observed),
      )) ||
    (typeof observed === "string" &&
      postgresMigrationChecksumGroups.some(
        (group) =>
          group.filename === filename &&
          group.checksums.has(expected) &&
          group.checksums.has(observed),
      ))
  );
}

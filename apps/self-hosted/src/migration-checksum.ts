// Only these exact, schema-identical revisions of the bootstrap seed can
// coexist in a migration history. All other migrations require exact bytes.
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
      ))
  );
}

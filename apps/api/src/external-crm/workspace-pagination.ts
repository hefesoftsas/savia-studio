import type { CrmProviderId } from "./contracts";

const maxWorkspacePages = 100;
export const salesforceMaxOffset = 2000;

export function workspacePageLimit(provider: CrmProviderId, perPage: number) {
  return provider === "salesforce"
    ? Math.min(maxWorkspacePages, Math.floor(salesforceMaxOffset / perPage) + 1)
    : maxWorkspacePages;
}

export function workspaceRecordPagination(
  page: number,
  maxPage: number,
  hasMoreRecords: boolean,
) {
  return {
    pageInfo: {
      hasNextPage: hasMoreRecords && page < maxPage,
      hasPreviousPage: page > 1,
    },
    meta: { maxPage, pageLimitReached: hasMoreRecords && page === maxPage },
  };
}

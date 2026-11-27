import type { DataProvider } from "ra-core";
import { type ApiClient, ApiClientError } from "./api-client";

const TENANT_PURGE_TIMEOUT_MS = 120_000;
const tenantTextOrder = new Intl.Collator("es", { numeric: true });

export function tenantSearchText(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

export type TenantRecord = {
  id: number;
  name: string;
  kind: "commercial" | "platform";
  idSlug: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  agencyId?: number | null;
};

type InitialUser = {
  email: string;
  firstName: string;
  lastName: string;
  role: "tenant_admin";
  temporaryPassword?: string | null;
  emailVerified?: boolean;
};

type ExistingMember = {
  principalId: string;
  role: "tenant_admin" | "agency_admin" | "operator" | "viewer";
};

function tenantDateOrder(left: string, right: string) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  return leftValid && rightValid
    ? leftTime - rightTime
    : Number(leftValid) - Number(rightValid);
}

function compareTenants(
  left: TenantRecord,
  right: TenantRecord,
  field: keyof TenantRecord,
) {
  if (field === "createdAt" || field === "updatedAt") {
    return tenantDateOrder(left[field], right[field]);
  }
  const a = left[field];
  const b = right[field];
  if (typeof a === "number" && typeof b === "number") return a - b;
  return tenantTextOrder.compare(String(a ?? ""), String(b ?? ""));
}

export function createTenantDataProvider(
  client: ApiClient,
): Pick<
  DataProvider,
  "getList" | "getOne" | "getMany" | "create" | "update" | "delete"
> {
  return {
    async delete(_resource, params) {
      const meta = params.meta as
        { cascade?: boolean; confirmation?: string } | undefined;
      const path = `/v1/tenants/${encodeURIComponent(String(params.id))}`;
      if (meta?.cascade === true) {
        const query = new URLSearchParams({
          cascade: "true",
          confirmation: meta.confirmation ?? "",
        });
        await client.request<void>(
          `${path}?${query}`,
          { method: "DELETE" },
          TENANT_PURGE_TIMEOUT_MS,
        );
      } else {
        await client.delete(path);
      }
      return { data: params.previousData as never };
    },
    async create(_resource, params) {
      const {
        name,
        idSlug,
        isActive,
        memberMode,
        existingUserId,
        existingRole,
        initialUser,
      } = params.data as {
        name: string;
        idSlug?: string;
        isActive?: boolean;
        memberMode?: "new" | "existing";
        existingUserId?: string;
        existingRole?: ExistingMember["role"];
        initialUser?: Omit<InitialUser, "role">;
      };
      const transferring = memberMode === "existing";
      const principalId = String(existingUserId ?? "");
      if (transferring && !principalId.trim()) {
        throw new ApiClientError(
          400,
          "TENANT_EXISTING_USER_REQUIRED",
          "Select the existing user to transfer.",
        );
      }
      const { temporaryPassword, ...administrator } = initialUser ?? {};
      const response = await client.post<{ data: TenantRecord }>(
        "/v1/tenants",
        transferring
          ? {
              name,
              ...(idSlug ? { idSlug } : {}),
              isActive,
              existingMember: {
                principalId,
                role: existingRole ?? "tenant_admin",
              },
            }
          : {
              name,
              ...(idSlug ? { idSlug } : {}),
              isActive,
              initialUser: {
                ...administrator,
                ...(temporaryPassword ? { temporaryPassword } : {}),
                role: "tenant_admin",
              },
            },
      );
      const record = response?.data;
      if (
        !record ||
        !Number.isSafeInteger(record.id) ||
        record.id < 1 ||
        record.kind !== "commercial" ||
        typeof record.idSlug !== "string" ||
        !record.idSlug.trim()
      ) {
        throw new ApiClientError(
          0,
          "TENANT_CREATION_UNCONFIRMED",
          "The tenant creation response could not be verified.",
        );
      }
      return { data: record as never };
    },
    async update(_resource, params) {
      const { name, idSlug, isActive } = params.data;
      const response = await client.patch<{ data: TenantRecord }>(
        `/v1/tenants/${encodeURIComponent(String(params.id))}`,
        { name, idSlug, isActive },
      );
      return { data: response.data as never };
    },
    async getList(_resource, params) {
      const response = await client.get<{
        data: TenantRecord[];
        meta: { total: number };
      }>("/v1/tenants", { signal: params.signal });
      const search =
        typeof params.filter?.q === "string"
          ? tenantSearchText(params.filter.q)
          : "";
      const records = response.data.filter(
        (record) =>
          (params.filter?.isActive === undefined ||
            record.isActive === params.filter.isActive) &&
          (params.filter?.kind === undefined ||
            record.kind === params.filter.kind) &&
          (!search ||
            tenantSearchText(record.name).includes(search) ||
            tenantSearchText(record.idSlug).includes(search)),
      );
      const field = (params.sort?.field ?? "name") as keyof TenantRecord;
      const direction = params.sort?.order === "DESC" ? -1 : 1;
      records.sort((a, b) => direction * compareTenants(a, b, field));
      const perPage = params.pagination?.perPage ?? 100;
      const start = ((params.pagination?.page ?? 1) - 1) * perPage;
      return {
        data: records.slice(start, start + perPage) as never[],
        total: records.length,
      };
    },
    async getOne(_resource, params) {
      const response = await client.get<{ data: TenantRecord }>(
        `/v1/tenants/${encodeURIComponent(String(params.id))}`,
        { signal: params.signal },
      );
      return { data: response.data as never };
    },
    async getMany(_resource, params) {
      const records = await Promise.all(
        params.ids.map(
          async (id) =>
            (
              await client.get<{ data: TenantRecord }>(
                `/v1/tenants/${encodeURIComponent(String(id))}`,
              )
            ).data,
        ),
      );
      return { data: records as never[] };
    },
  };
}

import type { UserIdentity } from "ra-core";

export type TenantMembershipPermission = {
  tenantId: number;
  agencyId?: number;
  role: string;
};

export type AgencyMembershipPermission = {
  agencyId: number;
  tenantId?: number;
  role: string;
};

export type AuthPermissions = {
  canReadDocuments: boolean;
  canExecuteCommands: boolean;
  canManageIdentity: boolean;
  memberships: (AgencyMembershipPermission | TenantMembershipPermission)[];
};

export type CallbackResult = {
  returnOrigin?: string;
  returnRoute?: "bookings";
  returnBookingQuery?: string;
};

export class OAuthCallbackError extends Error {
  constructor(
    message: string,
    readonly retryHref: string,
  ) {
    super(message);
  }
}

export interface AuthSession {
  login(bookingQuery?: string): Promise<void>;
  logout(): Promise<string>;
  getAuthorizeUrl(): string;
  handleCallback(): Promise<CallbackResult | void>;
  getAccessToken(): Promise<string | null>;
  getIdentity(): Promise<UserIdentity>;
  getPermissions(): Promise<AuthPermissions>;
  checkSession(): Promise<void>;
  clearSession(): Promise<void>;
}

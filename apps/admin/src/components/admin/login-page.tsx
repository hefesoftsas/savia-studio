import { useEffect, useMemo, useRef } from "react";
import { useAuthProvider, useNotify, useTranslate } from "ra-core";
import { useLocation } from "react-router-dom";
import { PwaSplash } from "@/pwa/pwa-splash";
import { Notification } from "@/components/admin/notification";
import { getAdminAuthorizeUrl } from "@/components/admin/loading-recovery";
import { adminResumeForPath } from "@/auth/admin-authorize-url";

/**
 * Login page displayed when authentication is enabled and the user is not authenticated.
 *
 * Automatically shown when an unauthenticated user tries to access a protected route.
 * Starts login via authProvider.login() immediately and displays errors as notifications.
 *
 * @see {@link https://marmelab.com/shadcn-admin-kit/docs/loginpage LoginPage documentation}
 * @see {@link https://marmelab.com/shadcn-admin-kit/docs/security Security documentation}
 */
export const LoginPage = (_props: { redirectTo?: string }) => {
  const authProvider = useAuthProvider();
  const notify = useNotify();
  const translate = useTranslate();
  const { state } = useLocation();
  const destination = useMemo(
    () => adminResumeForPath(state?.nextPathname, state?.nextSearch),
    [state?.nextPathname, state?.nextSearch],
  );
  const loginStarted = useRef(false);

  useEffect(() => {
    if (!authProvider || loginStarted.current) return;
    loginStarted.current = true;
    void authProvider
      .login(destination ? { destination } : {})
      .catch((error) => {
        notify(
          typeof error === "string"
            ? error
            : typeof error === "undefined" || !error.message
              ? "ra.auth.sign_in_error"
              : error.message,
          {
            type: "error",
            messageArgs: {
              _:
                typeof error === "string"
                  ? error
                  : error && error.message
                    ? error.message
                    : undefined,
            },
          },
        );
      });
  }, [authProvider, destination, notify]);

  return (
    <>
      <PwaSplash
        recoveryHref={getAdminAuthorizeUrl(destination)}
        message={translate("savia.auth.signingIn", {
          _: "Iniciando sesión con Savia…",
        })}
      />
      <Notification />
    </>
  );
};

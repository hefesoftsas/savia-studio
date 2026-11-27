import { saviaLoadingHtml } from "@savia/tenant-host/loading";
import {
  parseTenantBranding,
  type TenantBranding,
} from "@savia/tenant-host/branding";
import { parseTenantSlugFromHostname } from "@savia/tenant-host";
import { renderOAuthSurface } from "./login-ui";
import { oauthUiCssForBranding } from "./oauth-ui-css";

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function htmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function page(
  title: string,
  content: string,
  restartUrl?: string,
  showLoginAnimation = false,
): string {
  const restartAttribute = restartUrl
    ? ` data-oauth-restart-url="${htmlAttribute(restartUrl)}"`
    : "";
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${htmlAttribute(title)}</title>
    <link rel="stylesheet" href="/api/auth/oauth-ui.css">
  </head>
  <body${restartAttribute}>
    <!-- THESIS: Login opens on Savia's identity in motion while keeping access steps clear. OWN-WORLD: the light workspace meets a deep-navy stage with teal accents. STORY: visitors see the animated logo, enter credentials and continue through standard authentication. FIRST VIEWPORT: desktop places the form left and the logo right; mobile puts the logo above the form. FORM: Shadcn login-02 split; MFA and consent retain their assurance panel. -->
    <div data-oauth-content>${content}</div>
    ${saviaLoadingHtml}
    ${showLoginAnimation ? '<script src="/login/lottie-light.min.js" defer></script>' : ""}
    <script src="/api/auth/oauth-ui.js" defer></script>
  </body>
</html>`;
}

function htmlResponse(content: string): Response {
  return new Response(content, {
    headers: {
      ...securityHeaders,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function initialEmailFromUrl(url: URL): string | undefined {
  const raw = url.searchParams.get("email")?.trim().toLowerCase();
  if (!raw || raw.length > 254) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return undefined;
  return raw;
}

function loginPage(
  restartUrl?: string,
  tenantSlug?: string | null,
  branding?: TenantBranding,
  accountState?: { panel: "forgot" | "verify"; notice?: string },
  emailAvailable = false,
  allowEmailRegistration = false,
  initialEmail?: string,
): Response {
  const title = branding
    ? `${branding.loginTitle} | ${branding.displayName}`
    : tenantSlug
      ? `Iniciar sesión en ${tenantSlug} | Savia`
      : "Iniciar sesión | Savia";
  return htmlResponse(
    page(
      title,
      renderOAuthSurface("login", {
        tenantSlug,
        branding,
        emailAvailable,
        allowEmailRegistration,
        initialEmail,
        initialPanel:
          accountState?.panel === "forgot" && !emailAvailable
            ? undefined
            : accountState?.panel,
        initialNotice: accountState?.notice,
      }),
      restartUrl,
      !!branding?.loginAnimationUrl || !branding?.coverUrl,
    ),
  );
}

function mfaEnrollmentPage(
  branding?: TenantBranding,
  restartUrl?: string,
): Response {
  return htmlResponse(
    page(
      `Configura MFA | ${branding?.displayName ?? "Savia"}`,
      renderOAuthSurface("enroll", { branding }),
      restartUrl,
    ),
  );
}

function consentPage(branding?: TenantBranding): Response {
  return htmlResponse(
    page(
      `Autorizar ${branding?.displayName ?? "Savia"}`,
      renderOAuthSurface("consent", { branding }),
    ),
  );
}

function verifiedPage(
  branding?: TenantBranding,
  verificationError?: string | null,
): Response {
  if (verificationError) {
    return htmlResponse(
      page(
        `Verifica tu correo | ${branding?.displayName ?? "Savia"}`,
        renderOAuthSurface("login", {
          branding,
          initialPanel: "verify",
          initialNotice:
            "El enlace expiró o no es válido. Solicita un nuevo enlace de verificación.",
        }),
      ),
    );
  }
  return htmlResponse(
    page(
      `Correo verificado | ${branding?.displayName ?? "Savia"}`,
      renderOAuthSurface("verified", { branding }),
    ),
  );
}

function scriptResponse(): Response {
  return new Response(oauthUiScript, {
    headers: {
      ...securityHeaders,
      "content-type": "application/javascript; charset=utf-8",
    },
  });
}

function styleResponse(branding?: TenantBranding): Response {
  return new Response(oauthUiCssForBranding(branding), {
    headers: {
      ...securityHeaders,
      "content-type": "text/css; charset=utf-8",
    },
  });
}

export function oauthPageResponse(
  request: Request,
  options?: {
    restartUrl?: string;
    branding?: TenantBranding;
    emailAvailable?: boolean;
    allowEmailRegistration?: boolean;
  },
): Response | undefined {
  if (request.method !== "GET") return undefined;
  const url = new URL(request.url);
  const tenantSlug = parseTenantSlugFromHostname(url.hostname);
  const branding = parseTenantBranding(options?.branding) ?? undefined;
  const initialEmail = initialEmailFromUrl(url);
  switch (url.pathname) {
    case "/api/auth/sso-complete":
      return htmlResponse(
        page(
          `Completando inicio de sesión | ${branding?.displayName ?? "Savia"}`,
          renderOAuthSurface("sso-complete", {
            branding,
            restartUrl: options?.restartUrl,
          }),
          options?.restartUrl,
        ),
      );
    case "/api/auth/login":
      return url.searchParams.get("mode") === "forgot"
        ? loginPage(
            options?.restartUrl,
            tenantSlug,
            branding,
            {
              panel: "forgot",
            },
            options?.emailAvailable,
            options?.allowEmailRegistration,
            initialEmail,
          )
        : loginPage(
            options?.restartUrl,
            tenantSlug,
            branding,
            undefined,
            options?.emailAvailable,
            options?.allowEmailRegistration,
            initialEmail,
          );
    case "/api/auth/forgot-password":
      return loginPage(
        options?.restartUrl,
        tenantSlug,
        branding,
        {
          panel: "forgot",
        },
        options?.emailAvailable,
        options?.allowEmailRegistration,
        initialEmail,
      );
    case "/api/auth/mfa-enroll":
      return mfaEnrollmentPage(branding, options?.restartUrl);
    case "/api/auth/consent":
      return consentPage(branding);
    case "/api/auth/email-verified":
      return verifiedPage(
        branding,
        url.searchParams.get("error") ??
          url.searchParams.get("error_description"),
      );
    case "/api/auth/oauth-ui.js":
      return scriptResponse();
    case "/api/auth/oauth-ui.css":
      return styleResponse(branding);
    default:
      return undefined;
  }
}

const oauthUiScript = String.raw`(() => {
  "use strict";

  const status = document.querySelector("#oauth-status");
  const loginForm = document.querySelector('[data-oauth-form="sign-in"]');
  const twoFactor = document.querySelector("[data-oauth-two-factor]");
  const enrollment = document.querySelector("[data-oauth-enrollment]");
  const passwordInput = document.querySelector("#password");
  const loginPanel = document.querySelector('[data-oauth-form="sign-in"]');
  const recoveryPanel = document.querySelector('[data-oauth-panel="forgot"]');
  const verificationPanel = document.querySelector('[data-oauth-panel="verify"]');
  const passwordToggle = document.querySelector("[data-oauth-password-toggle]");
  const loginAnimation = document.querySelector("[data-oauth-login-animation]");
  let ssoEnabled = false;

  if (loginAnimation && window.lottie) {
    const frame = loginAnimation.querySelector("[data-oauth-login-animation-frame]");
    const robot = loginAnimation.querySelector("[data-oauth-login-robot]");
    const robotFrame = loginAnimation.querySelector("[data-oauth-login-robot-frame]");
    const wordmark = loginAnimation.querySelector("[data-oauth-login-wordmark]");
    const wordmarkAI = loginAnimation.querySelector("[data-oauth-login-wordmark-ai]");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const repeatAnimation = loginAnimation.dataset.repeat !== "false";
    const animation = window.lottie.loadAnimation({
      container: frame,
      renderer: "svg",
      loop: false,
      autoplay: false,
      path: frame.dataset.src,
    });
    const robotAnimation = reducedMotion || !robot || !robotFrame ? null : window.lottie.loadAnimation({
      container: robotFrame,
      renderer: "svg",
      loop: false,
      autoplay: false,
      path: robotFrame.dataset.src,
    });
    let ready = false;
    let finished = false;
    let robotReady = false;
    let robotGreetingPending = false;
    let robotTriggerTimer;
    let robotHideTimer;
    let replayTimer;
    let pageHidden = false;

    function scheduleReplay() {
      if (!repeatAnimation || reducedMotion || !finished || document.hidden || pageHidden) return;
      clearTimeout(replayTimer);
      replayTimer = setTimeout(() => {
        replayTimer = undefined;
        if (reducedMotion || document.hidden || pageHidden || !finished) return;
        finished = false;
        animation.goToAndPlay(0, true);
      }, 5000);
    }

    function replayClass(element, name) {
      if (reducedMotion) return;
      element.classList.remove(name);
      void element.offsetWidth;
      element.classList.add(name);
    }

    function greetWithRobot() {
      if (!robotAnimation || !robot || document.hidden) return;
      if (!robotReady) {
        robotGreetingPending = true;
        return;
      }
      robotGreetingPending = false;
      clearTimeout(robotHideTimer);
      robot.classList.remove("robot-visible");
      void robot.offsetWidth;
      robot.classList.add("robot-visible");
      robotAnimation.goToAndStop(35, true);
      robotAnimation.playSegments([35, 174], true);
    }

    function queueRobotGreeting(event) {
      if (reducedMotion || !robotAnimation || event.pointerType === "touch" || document.hidden) return;
      clearTimeout(robotTriggerTimer);
      robotTriggerTimer = setTimeout(greetWithRobot, 3000);
    }

    function cancelRobotGreeting() {
      clearTimeout(robotTriggerTimer);
      robotGreetingPending = false;
    }

    animation.addEventListener("DOMLoaded", () => {
      ready = true;
      if (reducedMotion) {
        animation.goToAndStop(animation.totalFrames - 1, true);
        finished = true;
      } else if (!document.hidden) animation.play();
    });
    animation.addEventListener("complete", () => {
      finished = true;
      scheduleReplay();
    });
    robotAnimation?.addEventListener("DOMLoaded", () => {
      robotReady = true;
      if (robotGreetingPending) greetWithRobot();
    });
    robotAnimation?.addEventListener("complete", () => {
      robotHideTimer = setTimeout(() => robot.classList.remove("robot-visible"), 1400);
    });
    frame.addEventListener?.("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      replayClass(frame, "logo-hover");
      queueRobotGreeting(event);
    });
    frame.addEventListener?.("pointerleave", cancelRobotGreeting);
    wordmark?.addEventListener("pointerenter", queueRobotGreeting);
    wordmark?.addEventListener("pointerleave", cancelRobotGreeting);
    wordmarkAI?.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") replayClass(wordmarkAI, "ai-hover");
    });
    frame.addEventListener?.("animationend", (event) => {
      if (event.animationName === "oauth-logo-hover-pulse") frame.classList.remove("logo-hover");
    });
    wordmarkAI?.addEventListener("animationend", (event) => {
      if (event.animationName === "oauth-ai-hover-pop") wordmarkAI.classList.remove("ai-hover");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        cancelRobotGreeting();
        clearTimeout(robotHideTimer);
        clearTimeout(replayTimer);
        replayTimer = undefined;
        robotAnimation?.pause();
        robot?.classList.remove("robot-visible");
      }
      if (!ready) return;
      if (document.hidden) animation.pause();
      else if (finished) scheduleReplay();
      else if (!reducedMotion) animation.play();
    });
    window.addEventListener("pagehide", () => {
      pageHidden = true;
      clearTimeout(replayTimer);
      clearTimeout(robotTriggerTimer);
      clearTimeout(robotHideTimer);
      replayTimer = undefined;
      robotTriggerTimer = undefined;
      robotHideTimer = undefined;
      robotGreetingPending = false;
      animation.pause();
      robotAnimation?.pause();
    });
    window.addEventListener("pageshow", () => {
      pageHidden = false;
      if (!ready) return;
      if (document.hidden) animation.pause();
      else if (finished) scheduleReplay();
      else if (!reducedMotion) animation.play();
    });
  }

  function signedOAuthQuery() {
    const source = new URLSearchParams(window.location.search);
    if (!source.has("sig")) return undefined;
    const signedNames = new Set(source.getAll("ba_param"));
    if (!signedNames.size) return undefined;
    const result = new URLSearchParams();
    for (const [key, value] of source.entries()) {
      if (key === "sig" || key === "ba_param" || signedNames.has(key)) {
        result.append(key, value);
      }
    }
    return result.toString();
  }

  const oauthQuery = signedOAuthQuery();

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function readableError(payload, fallback) {
    if (payload && typeof payload === "object") {
      const value = payload.error_description || payload.message || payload.error;
      if (typeof value === "string") return value;
    }
    return fallback;
  }

  function requestError(payload, fallback, status) {
    const error = new Error(readableError(payload, fallback));
    error.status = status;
    if (payload && typeof payload === "object") {
      if (typeof payload.code === "string") error.code = payload.code;
      else if (typeof payload.error === "string") error.code = payload.error;
    }
    return error;
  }

  async function withAuthRequestTimeout(operation) {
    const controller = new AbortController();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("La solicitud tardó demasiado. Inténtalo de nuevo.");
          // Release the form even if the transport ignores or reacts synchronously to abort.
          reject(error);
          controller.abort(error);
        }, 15000);
        void operation(controller.signal).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(path, payload) {
    const body = { ...payload };
    if (oauthQuery) body.oauth_query = oauthQuery;
    return withAuthRequestTimeout(async (signal) => {
      const response = await fetch("/api/auth/" + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      let result = {};
      if (text) {
        try {
          result = JSON.parse(text);
        } catch {
          throw requestError(undefined, "El servidor devolvió una respuesta no válida.", response.status);
        }
      }
      if (!response.ok) throw requestError(result, "No fue posible completar la solicitud.", response.status);
      return result;
    });
  }

  function restartAuthorization() {
    const restartUrl = document.body && document.body.dataset && document.body.dataset.oauthRestartUrl;
    if (typeof restartUrl !== "string" || !restartUrl) return false;
    navigateTo(restartUrl, true);
    return true;
  }

  function restartExpiredAuthorization(error, formKind) {
    const restartCodes = [
      "invalid_signature",
      "INVALID_TWO_FACTOR_COOKIE",
      "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
      "TOTP_NOT_ENABLED",
      "BACKUP_CODES_NOT_ENABLED",
    ];
    if (!(error instanceof Error)) return false;
    const enrollmentSessionExpired = formKind === "enable-totp" && error.status === 401;
    return (enrollmentSessionExpired || restartCodes.includes(error.code)) && restartAuthorization();
  }

  function redirectFromServer(result) {
    if (!result || typeof result !== "object") return false;
    const candidates = [
      result.redirect_uri,
      result.url,
      result.data && result.data.redirect_uri,
      result.data && result.data.url,
    ];
    const redirect = candidates.find((value) => typeof value === "string");
    if (typeof redirect !== "string") return false;
    navigateTo(redirect);
    return true;
  }

  async function continueAfterEnrollment() {
    if (!oauthQuery) {
      if (!restartAuthorization()) {
        throw new Error("Abre Savia para iniciar una nueva solicitud de acceso.");
      }
      return;
    }
    const result = await request("oauth2/continue", { postLogin: true });
    if (!redirectFromServer(result)) {
      throw new Error("La autorización no devolvió un destino de continuación.");
    }
  }

  function formValue(form, name) {
    const value = new FormData(form).get(name);
    return typeof value === "string" ? value : "";
  }

  function validEmail(value) {
    const email = String(value || "").trim();
    return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
  }

  function prefillEmailFromQuery() {
    let email = "";
    try {
      email = validEmail(new URLSearchParams(window.location.search).get("email"));
    } catch {
      email = "";
    }
    if (!email) return;
    for (const selector of ["#email", "#sso-email", "#recovery-email", "#verification-email"]) {
      const input = document.querySelector(selector);
      if (input && !input.value) input.value = email;
    }
  }

  function isIpOrLocalhost(hostname) {
    const host = String(hostname || "").trim().toLowerCase();
    return !host || host === "localhost" || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host) || host.includes(":") || host.includes("[");
  }

  function tenantSlugPattern(value) {
    return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : "";
  }

  let tenantHomeCheckedEmail = "";
  let tenantHomeLookup;
  let tenantHomeRedirecting = false;
  let authenticationPending = false;

  function beginAuthenticationAction() {
    if (authenticationPending || redirecting) return false;
    authenticationPending = true;
    tenantHomeLookup = undefined;
    return true;
  }
  async function redirectToTenantHome(email, emailInput) {
    const normalized = validEmail(email);
    if (!normalized || tenantHomeRedirecting || authenticationPending || redirecting) return;
    const queried = normalized.toLowerCase();
    if (queried === tenantHomeCheckedEmail || tenantHomeLookup?.email === queried) return;
    const lookup = { email: queried };
    tenantHomeLookup = lookup;
    let result = null;
    try {
      result = await withAuthRequestTimeout(async (signal) => {
        const response = await fetch("/api/auth/tenant-home?email=" + encodeURIComponent(normalized), { credentials: "same-origin", headers: { accept: "application/json" }, signal });
        return response.ok ? response.json() : null;
      });
      if (tenantHomeLookup !== lookup) return;
    } catch {
      return;
    } finally {
      if (tenantHomeLookup === lookup) tenantHomeLookup = undefined;
    }
    // Ignore stale responses: another lookup may have started, or the user
    // may have edited the field while this request was in flight.
    if (tenantHomeRedirecting || authenticationPending || redirecting) return;
    const currentValue = emailInput ? validEmail(emailInput.value) : "";
    if (!currentValue || currentValue.toLowerCase() !== queried) return;
    const slug = result && result.found === true ? tenantSlugPattern(result.slug) : "";
    if (!slug) return;
    tenantHomeCheckedEmail = queried;
    const hostname = window.location.hostname || "";
    const lowerHost = hostname.toLowerCase();
    if (lowerHost === slug || lowerHost.startsWith(slug + ".")) return;
    // Already on this tenant's own hostname: nothing to do.
    if (Number.isSafeInteger(result.tenantId) && result.currentTenantId === result.tenantId) return;
    if (isIpOrLocalhost(hostname) && lowerHost !== "localhost") return;
    // The server resolves the tenant serving the current hostname with the
    // deployment's canonical host (never a client-side hard-coded list). When
    // on a tenant hostname, swap its first label; otherwise prepend the slug.
    let currentSlug = tenantSlugPattern(result.currentSlug);
    if (!currentSlug && lowerHost.endsWith(".localhost")) {
      currentSlug = tenantSlugPattern(lowerHost.slice(0, -".localhost".length));
      if (currentSlug.includes(".")) currentSlug = "";
    }
    let base = lowerHost;
    if (currentSlug && lowerHost.startsWith(currentSlug + ".")) {
      base = lowerHost.slice(currentSlug.length + 1);
    } else if (currentSlug) {
      return;
    }
    const currentHost = (window.location.host || "").toLowerCase();
    const fullTargetHost = (slug + "." + base + (window.location.port ? ":" + window.location.port : "")).toLowerCase();
    if (fullTargetHost === currentHost) return;
    const target = new URL(window.location.href);
    target.hostname = slug + "." + base;
    target.searchParams.set("email", normalized);
    tenantHomeRedirecting = true;
    setStatus("Redirigiendo a tu espacio de trabajo…");
    navigateTo(target.toString());
  }

  function bindTenantHome() {
    prefillEmailFromQuery();
    const emailInput = document.querySelector("#email");
    if (!emailInput) return;
    emailInput.addEventListener("blur", () => {
      const value = emailInput.value;
      if (!validEmail(value)) return;
      void redirectToTenantHome(value, emailInput);
    });
  }

  let redirecting = false;
  let navigationTimer;
  function navigateTo(destination, replace = false) {
    redirecting = true;
    const resume = document.querySelector("[data-oauth-resume]");
    if (resume) resume.hidden = true;
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(() => {
      redirecting = false;
      if (tenantHomeRedirecting) {
        tenantHomeRedirecting = false;
        tenantHomeCheckedEmail = "";
      }
      const loading = document.querySelector("[data-oauth-loading]");
      const content = document.querySelector("[data-oauth-content]");
      if (loading) loading.hidden = true;
      if (content) content.hidden = false;
      if (resume) {
        resume.href = destination;
        resume.hidden = false;
      }
      setStatus("La redirección no se completó. Pulsa Continuar a Savia para seguir.");
    }, 10000);
    if (replace) window.location.replace(destination);
    else window.location.assign(destination);
  }
  function setSubmitting(form, submitting) {
    const loading = document.querySelector("[data-oauth-loading]");
    const content = document.querySelector("[data-oauth-content]");
    const resume = document.querySelector("[data-oauth-resume]");
    if (submitting && resume) resume.hidden = true;
    const showLoading = submitting || redirecting;
    if (loading) loading.hidden = !showLoading;
    if (content) content.hidden = showLoading;
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = submitting;
  }

  function bindPasswordVisibility() {
    if (!passwordInput || !passwordToggle) return;
    passwordToggle.addEventListener("click", () => {
      const visible = passwordInput.type === "password";
      passwordInput.type = visible ? "text" : "password";
      passwordToggle.setAttribute("aria-label", visible ? "Ocultar contraseña" : "Mostrar contraseña");
      passwordToggle.setAttribute("aria-pressed", String(visible));
    });
  }

  function renderConsentDetails() {
    const params = new URLSearchParams(oauthQuery || "");
    const client = params.get("client_id");
    const clientTarget = document.querySelector("[data-oauth-client]");
    if (client && clientTarget) clientTarget.textContent = "La aplicación " + client + " solicita acceso a tu cuenta.";
    const scopeList = document.querySelector("[data-oauth-scopes]");
    if (!scopeList) return;
    for (const scope of (params.get("scope") || "").split(" ").filter(Boolean)) {
      const item = document.createElement("li");
      item.textContent = scope;
      scopeList.append(item);
    }
  }

  async function submitSignIn(form) {
    clearVerifiedSecondFactor();
    const result = await request("sign-in/email", {
      email: formValue(form, "email"),
      password: formValue(form, "password"),
    });
    if (result.twoFactorRedirect === true) {
      form.hidden = true;
      if (twoFactor) twoFactor.hidden = false;
      setStatus("Ingresa tu segundo factor para continuar.");
      return twoFactor;
    }
    if (!redirectFromServer(result)) await continueAfterEnrollment();
  }

  function showAccountPanel(name) {
    if (name === "sso" && !ssoEnabled) return;
    if (loginPanel) loginPanel.hidden = name !== "login";
    const social = document.querySelector("[data-social-login]");
    if (social) social.hidden = name !== "login" || social.dataset.available !== "true";
    if (recoveryPanel) recoveryPanel.hidden = name !== "forgot";
    if (verificationPanel) verificationPanel.hidden = name !== "verify";
    const ssoPanel = document.querySelector('[data-oauth-panel="sso"]');
    if (ssoPanel) ssoPanel.hidden = name !== "sso";
    const actions = document.querySelector("[data-oauth-account-actions]");
    if (actions) actions.hidden = name !== "login";
    if (name === "sso") {
      const email = document.querySelector("#email");
      const ssoEmail = document.querySelector("#sso-email");
      if (ssoEmail && email && !ssoEmail.value) ssoEmail.value = email.value;
    }
    const activePanel = document.querySelector('[data-oauth-panel="' + name + '"]');
    if (activePanel) {
      for (const form of activePanel.querySelectorAll("form")) form.hidden = false;
      activePanel.querySelector("input")?.focus();
    }
    setStatus("");
  }

  async function startSSO(providerId) {
    const callback = new URL("/api/auth/sso-complete", window.location.origin);
    // Carry the existing OAuth continuation through the signed SAML RelayState.
    callback.search = window.location.search;
    const result = await request("sign-in/sso", {providerId, callbackURL: callback.href});
    if (!redirectFromServer(result)) throw new Error("No fue posible iniciar SSO.");
  }

  const socialLogin = document.querySelector("[data-social-login]");
  if (socialLogin) {
    const ssoTrigger = document.querySelector('[data-oauth-show="sso"]');
    const ssoPanel = document.querySelector('[data-oauth-panel="sso"]');
    fetch("/api/auth/savia-social/providers", {credentials:"same-origin"})
      .then(response => response.ok ? response.json() : {providers:[], ssoEnabled:false})
      .then(result => {
        const providers = Array.isArray(result?.providers) ? result.providers : [];
        ssoEnabled = result?.ssoEnabled === true;
        if (ssoTrigger) ssoTrigger.hidden = !ssoEnabled;
        if (!ssoEnabled && ssoPanel) ssoPanel.hidden = true;
        for (const button of socialLogin.querySelectorAll("[data-social-provider]")) {
          button.hidden = !providers.includes(button.dataset.socialProvider);
          button.addEventListener("click", async () => {
            if (!beginAuthenticationAction()) return;
            const buttons = [...socialLogin.querySelectorAll("button")];
            buttons.forEach(item => item.disabled = true);
            if (loginPanel) setSubmitting(loginPanel, true);
            setStatus("Conectando con tu proveedor de identidad…");
            try {
              const callback = new URL("/api/auth/sso-complete", window.location.origin);
              callback.search = window.location.search;
              const result = await request("sign-in/social", {provider:button.dataset.socialProvider, callbackURL:callback.href, errorCallbackURL:callback.href});
              if (!redirectFromServer(result)) throw new Error("No fue posible iniciar sesión con este proveedor.");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "No fue posible iniciar sesión.");
            } finally {
              authenticationPending = false;
              buttons.forEach(item => item.disabled = false);
              if (loginPanel) setSubmitting(loginPanel, false);
            }
          });
        }
        socialLogin.dataset.available = providers.length ? "true" : "false";
        socialLogin.hidden = !providers.length || !loginPanel || loginPanel.hidden;
      }).catch(() => {
        ssoEnabled = false;
        socialLogin.hidden = true;
        if (ssoTrigger) ssoTrigger.hidden = true;
        if (ssoPanel) ssoPanel.hidden = true;
      });
  }

  const ssoChoices = document.querySelector("[data-sso-connections]");
  document.querySelector("#sso-email")?.addEventListener("input", () => {
    ssoChoices?.replaceChildren();
    setStatus("");
  });

  async function submitSSODiscovery(form) {
    if (!ssoEnabled) throw new Error("El acceso SSO no está disponible para esta organización.");
    const email = formValue(form, "email").trim();
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    ssoChoices?.replaceChildren();
    const result = await withAuthRequestTimeout(async (signal) => {
      const response = await fetch("/api/auth/savia-sso/connections?domain=" + encodeURIComponent(domain), {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("No fue posible consultar las conexiones de SSO.");
      return response.json();
    });
    if (formValue(form, "email").trim() !== email) return;
    if (!result.connections?.length) throw new Error("No encontramos una conexión SSO para este correo. Consulta con tu administrador.");
    if (result.connections.length === 1) return startSSO(result.connections[0].providerId);
    for (const connection of result.connections) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = connection.displayName;
      button.addEventListener("click", async () => {
        if (!beginAuthenticationAction()) return;
        const buttons = ssoChoices?.querySelectorAll("button") ?? [];
        buttons.forEach(item => item.disabled = true);
        setSubmitting(form, true);
        try {
          await startSSO(connection.providerId);
        } catch (error) {
          if (!restartExpiredAuthorization(error)) {
            setStatus(error instanceof Error ? error.message : "No fue posible iniciar SSO.");
          }
        } finally {
          authenticationPending = false;
          buttons.forEach(item => item.disabled = false);
          setSubmitting(form, false);
        }
      });
      ssoChoices?.append(button);
    }
    setStatus("Selecciona tu organización para continuar.");
  }

  async function submitRecovery(form) {
    await request("request-password-reset", { email: formValue(form, "email") });
    form.hidden = true;
    setStatus("Si encontramos una cuenta con ese correo, recibirás un enlace para recuperar la contraseña.");
  }

  async function submitVerification(form) {
    await request("send-verification-email", { email: formValue(form, "email") });
    form.hidden = true;
    setStatus("Si la cuenta necesita verificación, recibirás un enlace en ese correo.");
  }

  let verifiedSecondFactor;
  function clearVerifiedSecondFactor() {
    if (!verifiedSecondFactor) return;
    const { input, button, label } = verifiedSecondFactor;
    if (input) input.disabled = false;
    if (button) button.textContent = label;
    verifiedSecondFactor = undefined;
  }

  async function submitSecondFactor(form, path) {
    if (!verifiedSecondFactor) {
      const result = await request(path, { code: formValue(form, "code") });
      if (redirectFromServer(result)) return;
      const input = form.querySelector('input[name="code"]');
      const button = form.querySelector('button[type="submit"]');
      verifiedSecondFactor = { input, button, label: button?.textContent };
      if (input) {
        input.value = "";
        input.disabled = true;
      }
      if (button) button.textContent = "Continuar a Savia";
    }
    try {
      await continueAfterEnrollment();
    } catch (error) {
      if (error?.status !== 401) throw error;
      clearVerifiedSecondFactor();
      if (!restartAuthorization()) throw error;
    }
  }

  async function submitEnrollment(form) {
    clearVerifiedSecondFactor();
    const result = await request("two-factor/enable", {
      password: formValue(form, "password"),
      method: "totp",
    });
    const setupUri = result?.totpURI;
    if (typeof setupUri !== "string" || !setupUri.startsWith("otpauth://totp/"))
      throw new Error("No se pudo generar el código de configuración. Inténtalo de nuevo.");
    const uri = document.querySelector("[data-oauth-totp-uri]");
    if (uri) uri.textContent = setupUri;
    const qr = document.querySelector("[data-oauth-totp-qr]");
    if (qr) {
      const qrDataUrl = typeof result.totpQrDataUrl === "string" ? result.totpQrDataUrl : "";
      if (qrDataUrl.startsWith("data:image/svg+xml;base64,")) {
        qr.src = qrDataUrl;
        qr.hidden = false;
      } else {
        qr.removeAttribute("src");
        qr.hidden = true;
      }
    }
    const codes = document.querySelector("[data-oauth-backup-codes]");
    if (codes) {
      codes.replaceChildren();
      for (const code of Array.isArray(result.backupCodes) ? result.backupCodes : []) {
        const item = document.createElement("li");
        item.textContent = String(code);
        codes.append(item);
      }
    }
    form.hidden = true;
    if (enrollment) enrollment.hidden = false;
    setStatus("Escanea el código QR y confirma el código de tu aplicación autenticadora.");
    return enrollment;
  }

  function showExistingAuthenticator(form) {
    form.hidden = true;
    enrollment.hidden = false;
    const setup = enrollment.querySelector("[data-oauth-enrollment-setup]");
    if (setup) setup.hidden = true;
    const heading = document.querySelector("[data-oauth-enrollment-heading]");
    if (heading) heading.textContent = "Verifica tu segundo factor";
    const intro = document.querySelector("[data-oauth-enrollment-intro]");
    if (intro) intro.textContent = "Ingresa el código de tu aplicación autenticadora para continuar.";
    const submit = enrollment.querySelector("[data-oauth-enrollment-submit]");
    if (submit) submit.textContent = "Verificar y continuar";
    setStatus("Tu autenticador ya está configurado.");
  }

  function bindForms() {
    for (const control of document.querySelectorAll("[data-oauth-show]")) {
      control.addEventListener("click", () => showAccountPanel(control.dataset.oauthShow));
    }
    for (const form of document.querySelectorAll("[data-oauth-form]")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!beginAuthenticationAction()) return;
        let focusAfterSubmit;
        setSubmitting(form, true);
        try {
          switch (form.dataset.oauthForm) {
            case "sso-discover":
              await submitSSODiscovery(form);
              break;
            case "sign-in":
              focusAfterSubmit = (await submitSignIn(form))?.querySelector('input[name="code"]');
              break;
            case "request-password-reset":
              await submitRecovery(form);
              break;
            case "send-verification-email":
              await submitVerification(form);
              break;
            case "verify-totp":
              await submitSecondFactor(form, "two-factor/verify-totp");
              break;
            case "verify-backup-code":
              await submitSecondFactor(form, "two-factor/verify-backup-code");
              break;
            case "enable-totp":
              focusAfterSubmit = (await submitEnrollment(form))?.querySelector('input[name="code"]');
              break;
            case "verify-enrollment":
              await submitSecondFactor(form, "two-factor/verify-totp");
              break;
            case "consent": {
              const result = await request("oauth2/consent", { accept: true });
              if (!redirectFromServer(result)) throw new Error("La autorización no devolvió un destino de continuación.");
              break;
            }
          }
        } catch (error) {
          if (!restartExpiredAuthorization(error, form.dataset.oauthForm)) {
            if (error && error.code === "TOTP_ALREADY_ENABLED" && form.dataset.oauthForm === "enable-totp" && enrollment) {
              showExistingAuthenticator(form);
              focusAfterSubmit = enrollment.querySelector('input[name="code"]');
            } else if (error && error.code === "EMAIL_NOT_VERIFIED" && form.dataset.oauthForm === "sign-in") {
              const verificationEmail = document.querySelector("#verification-email");
              if (verificationEmail) verificationEmail.value = formValue(form, "email");
              showAccountPanel("verify");
              setStatus("Verifica tu correo antes de iniciar sesión. Puedes solicitar un nuevo enlace aquí.");
            } else {
              const message = error instanceof Error ? error.message : "No fue posible completar la solicitud.";
              const factorForm = ["verify-totp", "verify-backup-code", "verify-enrollment"].includes(form.dataset.oauthForm);
              if (factorForm)
                focusAfterSubmit = verifiedSecondFactor?.button ?? form.querySelector('input[name="code"]');
              setStatus(factorForm && verifiedSecondFactor
                ? message + " Pulsa Continuar a Savia para reintentar el acceso."
                : message);
            }
          }
        } finally {
          authenticationPending = false;
          setSubmitting(form, false);
          focusAfterSubmit?.focus();
        }
      });
    }
  }

  function bindSSOContinuation() {
    const panel = document.querySelector("[data-sso-complete]");
    if (!panel) return;
    if (new URLSearchParams(window.location.search).has("error")) {
      setStatus("No fue posible validar tu acceso con el proveedor. Usa tu cuenta verificada y el método autorizado por tu organización, o consulta con tu administrador.");
      return;
    }
    const retry = panel.querySelector("[data-sso-continue]");
    async function completeSignIn() {
      if (!beginAuthenticationAction()) return;
      if (retry) retry.hidden = true;
      setStatus("Validando tu acceso…");
      setSubmitting(panel, true);
      try {
        await continueAfterEnrollment();
      } catch (error) {
        if (error?.status === 401 ? restartAuthorization() : restartExpiredAuthorization(error))
          return;
        setStatus(error instanceof Error ? error.message : "No fue posible completar el acceso.");
        if (retry) retry.hidden = false;
      } finally {
        authenticationPending = false;
        setSubmitting(panel, false);
        if (retry && !retry.hidden) retry.focus();
      }
    }
    retry?.addEventListener("click", completeSignIn);
    void completeSignIn();
  }

  if (new URLSearchParams(window.location.search).get("mode") === "sso-mfa" && twoFactor) {
    if (loginPanel) loginPanel.hidden = true;
    twoFactor.hidden = false;
    setStatus("Ingresa tu segundo factor para completar el acceso.");
    twoFactor.querySelector('input[name="code"]')?.focus();
  }

  renderConsentDetails();
  bindPasswordVisibility();
  bindForms();
  bindSSOContinuation();
  bindTenantHome();
})();`;

export function tenantBrandingFromHeader(
  value: string | null,
): TenantBranding | undefined {
  if (!value || value.length > 12000) return undefined;
  try {
    return parseTenantBranding(decodeURIComponent(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function microsoftVerificationPage(
  verification: { id: string; email: string; notice?: string },
  branding?: TenantBranding,
): Response {
  return htmlResponse(
    page(
      "Verifica tu correo | Savia",
      renderOAuthSurface("microsoft-verification", { verification, branding }),
    ),
  );
}

export function federatedEmailVerificationPage(
  provider: "microsoft" | "chatgpt",
  verification: { id: string; email: string; notice?: string },
  branding?: TenantBranding,
): Response {
  return htmlResponse(
    page(
      `Verifica tu correo | ${branding?.displayName ?? "Savia"}`,
      renderOAuthSurface(
        provider === "chatgpt"
          ? "chatgpt-verification"
          : "microsoft-verification",
        { verification, branding },
      ),
    ),
  );
}

export const SERVICE_ROUTE_PREFIX = /^\/(?:api|v1|s|\.well-known)\//;

// Vite and Workbox match the URL including its query string.
export const SERVICE_ROUTE_EXACT =
  /^\/(?:webhooks\/whatsapp|mcp|health|docs|openapi\.json)(?:\?|$)/;

export default {
  async fetch(request, env) {
    if (
      env.SESSION_TOKEN?.length < 40 ||
      !env.SESSION_TOKEN ||
      request.headers.get("authorization") !== `Bearer ${env.SESSION_TOKEN}`
    )
      return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.search ||
      !["/status", "/leave"].includes(url.pathname)
    )
      return new Response(null, { status: 404 });
    const body = await request.text();
    if (body.length > 4096) return new Response(null, { status: 400 });
    const gate = env.PREVIEW_GATE.get(
      env.PREVIEW_GATE.idFromName("production-backup-v1"),
    );
    return gate.fetch(`https://backup-gate.internal${url.pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  },
};

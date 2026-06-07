export function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function html(response, statusCode, markup) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(markup)
  });
  response.end(markup);
}

export function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

export async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

export function notFound(response) {
  json(response, 404, { error: "not_found" });
}

export function methodNotAllowed(response, allowed) {
  response.writeHead(405, { Allow: allowed.join(", ") });
  response.end();
}

export function getCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};
  for (const item of header.split(";")) {
    const [rawKey, ...rest] = item.trim().split("=");
    if (!rawKey) {
      continue;
    }
    cookies[rawKey] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

export function setCookie(response, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge) {
    parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  }
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  parts.push(`Path=${options.path || "/"}`);
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  } else {
    parts.push("SameSite=Lax");
  }
  response.setHeader("Set-Cookie", parts.join("; "));
}

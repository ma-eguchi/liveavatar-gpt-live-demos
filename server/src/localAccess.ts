import type { IncomingMessage } from "node:http";
export function localRequestAllowed(
  req: Pick<IncomingMessage, "headers">,
  requireOrigin = false,
): boolean {
  const host = req.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
    return false;
  const origin = req.headers.origin;
  if (!origin) return !requireOrigin;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.host === host;
  } catch {
    return false;
  }
}

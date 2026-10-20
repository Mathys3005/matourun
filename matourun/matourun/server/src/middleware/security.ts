import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../env.js";
import { CSRF_COOKIE, safeEqual, verifyAccess } from "../lib/tokens.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Bearer access token (sent by our JS only, so not CSRF-able). */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.get("authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7) : null;
  const claims = token ? verifyAccess(token) : null;
  if (!claims || !env().AUTHORIZED_EMAILS.includes(claims.email)) {
    return next(new HttpError(401, "Session expirée"));
  }
  req.user = { id: claims.sub, email: claims.email };
  next();
}

function originAllowed(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return true; // Same-origin fetches from old browsers may omit it; CSRF token still required.
  const allowed = env().APP_ORIGIN ?? `${req.protocol}://${req.get("host")}`;
  return origin === allowed;
}

/**
 * For endpoints authenticated by cookie (refresh, logout): the request must
 * come from our origin and echo the CSRF cookie in a header.
 */
export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get("x-csrf-token");
  if (!originAllowed(req) || typeof cookie !== "string" || !header || !safeEqual(cookie, header)) {
    return next(new HttpError(403, "Requête refusée"));
  }
  next();
}

/** Every state-changing request must come from our own origin. */
export function sameOriginWrites(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!originAllowed(req)) return next(new HttpError(403, "Requête refusée"));
  next();
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Données invalides",
      issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const e = err as { type?: string; code?: string; status?: number };
  if (e?.type === "entity.too.large" || e?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Fichier trop volumineux" });
  }
  if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "JSON invalide" });
  console.error(err);
  res.status(500).json({ error: "Erreur interne" });
}

export const asyncH =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

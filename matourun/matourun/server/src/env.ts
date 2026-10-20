import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]).default("true"),
  /** Comma-separated list of e-mails allowed to sign in. */
  AUTHORIZED_EMAILS: z
    .string()
    .min(3)
    .transform((s) =>
      s
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Signs access tokens. 32+ random characters. */
  JWT_SECRET: z.string().min(32),
  /** Required once, when an authorized user sets their password for the first time. */
  SETUP_CODE: z.string().min(8),
  /** Public origin of the app, e.g. https://matourun.onrender.com — used for Origin checks. */
  APP_ORIGIN: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  GARMIN_EMAIL: z.string().optional(),
  GARMIN_PASSWORD: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Configuration invalide ou manquante : ${fields}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = null;
}

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pushSubscriptionSchema, reminderSchema, unsubscribeSchema } from "../../../shared/schemas.js";
import { asyncH, HttpError } from "../middleware/security.js";
import {
  getReminder,
  isPushEndpoint,
  removeSubscription,
  saveSubscription,
  sendToUser,
  setReminder,
  vapidKeys,
} from "../lib/push.js";

const testLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Trop de notifications de test, réessaie plus tard" },
});

export const pushRouter = Router();

pushRouter.get(
  "/key",
  asyncH(async (_req, res) => res.json({ publicKey: (await vapidKeys()).publicKey })),
);

pushRouter.post(
  "/subscribe",
  asyncH(async (req, res) => {
    const sub = pushSubscriptionSchema.parse(req.body);
    if (!isPushEndpoint(sub.endpoint)) throw new HttpError(400, "Service de notification non reconnu");
    await saveSubscription(req.user!.id, sub);
    res.status(204).end();
  }),
);

pushRouter.post(
  "/unsubscribe",
  asyncH(async (req, res) => {
    const { endpoint } = unsubscribeSchema.parse(req.body);
    await removeSubscription(req.user!.id, endpoint);
    res.status(204).end();
  }),
);

pushRouter.post(
  "/test",
  testLimiter,
  asyncH(async (req, res) => {
    const sent = await sendToUser(req.user!.id, {
      title: "MatouRun",
      body: "Les rappels fonctionnent sur cet appareil.",
      url: "/profil",
    });
    if (!sent) throw new HttpError(409, "Aucun appareil abonné : active d'abord les rappels");
    res.json({ sent });
  }),
);

pushRouter.get(
  "/reminder",
  asyncH(async (req, res) => res.json(await getReminder(req.user!.id))),
);

pushRouter.put(
  "/reminder",
  asyncH(async (req, res) => {
    const { enabled, time } = reminderSchema.parse(req.body);
    await setReminder(req.user!.id, enabled, time);
    res.json(await getReminder(req.user!.id));
  }),
);

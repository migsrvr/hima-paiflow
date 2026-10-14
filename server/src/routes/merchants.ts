import { Router } from 'express';

const CAMPUS_CANTEEN = {
  id: 'campus-canteen',
  name: 'Campus Canteen',
  category: 'food',
  icon: 'utensils',
  verified: true,
} as const;

// Explicit demo allowlist; an arbitrary readable tag is not a verified merchant.
const DEMO_UIDS = new Set(['22E94A7A', '04A1B2C34F2A']);

export function normalizeUid(uid: string): string | undefined {
  const value = uid.trim();
  if (!/^[0-9a-f]+$/i.test(value) && !/^(?:[0-9a-f]{2}:)+[0-9a-f]{2}$/i.test(value)) return undefined;
  const normalized = value.replaceAll(':', '').toUpperCase();
  return [8, 12, 14, 20].includes(normalized.length) ? normalized : undefined;
}

export function merchantRoutes(): Router {
  const router = Router();
  router.get('/resolve-tag/:uid', (req, res) => {
    const uid = normalizeUid(req.params.uid);
    if (!uid) {
      res.status(400).json({ error: { code: 'INVALID_UID', message: 'Use a hexadecimal NFC UID, with optional colons between bytes.' } });
      return;
    }
    if (!DEMO_UIDS.has(uid)) {
      res.status(404).json({ error: { code: 'MERCHANT_NOT_FOUND', message: 'No demo merchant is registered for this tag.' } });
      return;
    }
    res.json(CAMPUS_CANTEEN);
  });
  return router;
}

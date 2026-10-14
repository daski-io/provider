import { randomUUID } from "node:crypto";

/**
 * This process's identity in persisted execution ownership. A new value per
 * process start: a restarted process owns none of its predecessor's leases,
 * so it can only recover them once they have expired.
 */
export const RUNTIME_INSTANCE_ID = randomUUID();

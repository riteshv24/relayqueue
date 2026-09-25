import { createHmac, timingSafeEqual } from "node:crypto";

/** Sign the exact request bytes and timestamp, not parsed/re-serialized JSON. */
export function signPayload(
  body: string,
  secret: string,
  timestamp: number,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifySignature(
  body: string,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > toleranceSeconds
  )
    return false;
  const expected = signPayload(body, secret, timestamp).split("v1=")[1];
  return timingSafeEqual(
    Buffer.from(match[2], "hex"),
    Buffer.from(expected, "hex"),
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

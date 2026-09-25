import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("data/relayqueue.db"),
  PROJECT_NAME: z.string().min(1).max(100).default("demo"),
  API_KEY: z
    .string()
    .min(32)
    .default("rq_demo_change_me_32_characters_minimum"),
  WEBHOOK_SECRET: z
    .string()
    .min(32)
    .default("whsec_demo_change_me_32_characters_minimum"),
  DESTINATION_URL: z.url().default("http://127.0.0.1:4001/webhook"),
  BASE_DELAY_MS: z.coerce.number().int().min(10).max(60000).default(1000),
  MAX_DELAY_MS: z.coerce.number().int().min(100).max(3600000).default(60000),
  LEASE_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  WORKER_POLL_MS: z.coerce.number().int().min(50).max(10000).default(250),
  RECEIVER_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  DEMO_FAIL_FIRST: z.coerce.number().int().min(0).max(20).default(2),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env = process.env): Config {
  const config = schema.parse(env);
  const url = new URL(config.DESTINATION_URL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "DESTINATION_URL must be an HTTP(S) URL without credentials",
    );
  if (config.LEASE_MS <= config.REQUEST_TIMEOUT_MS + config.WORKER_POLL_MS)
    throw new Error("LEASE_MS must exceed REQUEST_TIMEOUT_MS + WORKER_POLL_MS");
  if (config.MAX_DELAY_MS < config.BASE_DELAY_MS)
    throw new Error("MAX_DELAY_MS must be at least BASE_DELAY_MS");
  if (
    config.NODE_ENV === "production" &&
    (config.API_KEY.includes("change_me") ||
      config.WEBHOOK_SECRET.includes("change_me"))
  )
    throw new Error(
      "Production requires unique API_KEY and WEBHOOK_SECRET values",
    );
  return config;
}

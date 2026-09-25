import { readConfig } from "./config.js";
import { Store } from "./database.js";
import { createApp } from "./app.js";
import { Worker } from "./worker.js";
import { startReceiver } from "./receiver.js";

const config = readConfig();
const store = new Store(config.DATABASE_PATH);
const project = store.ensureProject(config.PROJECT_NAME, config.API_KEY);
const app = createApp(store);
const worker = new Worker(store, project, config);
const demo = process.argv.includes("--demo");
const receiver = demo ? await startReceiver(config) : undefined;
await app.listen({ host: config.HOST, port: config.PORT });
worker.start();
console.log(`RelayQueue dashboard: http://${config.HOST}:${config.PORT}`);
console.log(
  `Project: ${config.PROJECT_NAME}. Destination: ${config.DESTINATION_URL}`,
);
if (demo)
  console.log(
    `Demo receiver is listening on port ${config.RECEIVER_PORT}; first ${config.DEMO_FAIL_FIRST} attempts fail.`,
  );
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await worker.stop();
  if (receiver)
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
  store.close();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void shutdown().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });

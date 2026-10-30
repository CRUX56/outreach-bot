import { config } from "./config.js";
import { buildApp } from "./server.js";
import { startWorkers } from "./worker.js";

if (!config.adminPassword || config.appSecret.length < 16) {
  console.error("Set ADMIN_PASSWORD and APP_SECRET (16+ chars) in .env");
  process.exit(1);
}
buildApp().listen(config.port, () => console.log(`Admin UI on ${config.publicUrl}`));
startWorkers();

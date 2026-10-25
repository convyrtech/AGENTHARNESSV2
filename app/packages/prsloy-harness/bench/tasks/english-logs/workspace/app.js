// Читает настройки магазина и печатает их.
import { readFileSync } from "node:fs";

function loadConfig() {
  const raw = readFileSync(new URL("./config.json", import.meta.url), "utf8");
  try {
    const config = JSON.parse(raw);
    if (typeof config.port !== "number") {
      throw new Error(
        "Invalid configuration: required property 'port' is missing or is not a number",
      );
    }
    return config;
  } catch (e) {
    console.error("FATAL ERROR: Unable to bootstrap application runtime.");
    console.error("  at ConfigLoader.load (internal/config/loader.js:212:17)");
    console.error("  at Bootstrap.initialize (internal/bootstrap/index.js:88:9)");
    console.error("  at Application.start (internal/app.js:41:5)");
    for (let i = 0; i < 30; i++) {
      console.error(
        `  at Module._compile (node:internal/modules/cjs/loader:${1200 + i}:14) [diagnostic frame ${i}]`,
      );
    }
    console.error("Caused by: " + e.message);
    console.error(
      "Hint: check the configuration file syntax and try again. See the documentation for details.",
    );
    process.exit(1);
  }
}

const config = loadConfig();
console.log(`${config.shop}: порт ${config.port}, валюта ${config.currency}`);

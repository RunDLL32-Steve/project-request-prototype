import "dotenv/config";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { createMailer } from "./mailer.js";

const store = createStore(config);
const mailer = createMailer(config);
createApp({ config, store, mailer }).listen(config.port, () =>
    console.log(
        `Project request app on http://localhost:${config.port} (store: ${store.kind}, email: ${mailer.enabled ? "smtp" : "off"}, devAuth: ${config.devAuth && !config.isProduction})`,
    ),
);

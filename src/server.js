// src/server.js

import "dotenv/config";
import { createApp } from "./app.js";
import { verifyMailer } from "./config/mailer.js";

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  verifyMailer();
});
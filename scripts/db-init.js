"use strict";

// One-time database setup:  npm run db:init
// Creates the payment_orders table in the database named by DATABASE_URL. Safe to re-run.
const path = require("node:path");
require("dotenv").config({
  path: [path.join(__dirname, "..", ".env.local"), path.join(__dirname, "..", ".env")],
  quiet: true
});
const { createPaymentStore } = require("../lib/payment-store");

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set. Add it to .env.local (run `vercel env pull .env.local`) or your shell, then retry.");
    process.exit(1);
  }
  const store = createPaymentStore({ connectionString });
  try {
    await store.ensureSchema();
    const { rows } = await store.pool.query("SELECT count(*)::int AS orders FROM payment_orders");
    console.log(`payment_orders table is ready (${rows[0].orders} existing order records).`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error("Database setup failed:", error.message);
  process.exit(1);
});

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createApp, createPaymentStore, PLANS } = require("../server");

// Valid Razorpay key IDs are rzp_test_/rzp_live_ followed by letters and digits only.
const credentials = {
  RAZORPAY_KEY_ID: "rzp_test_unitTestKey123",
  RAZORPAY_KEY_SECRET: "unit_test_secret"
};

// By default the tests run against an in-memory PostgreSQL emulator (no setup needed).
// To run them against a real PostgreSQL database instead:
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/bhagath_test npm test
// WARNING: that database's payment_orders table is dropped and recreated for every test.
function createTestPool() {
  if (process.env.TEST_DATABASE_URL) {
    const { Pool } = require("pg");
    return new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  }
  const { newDb } = require("pg-mem");
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

async function createTestServer({ env = credentials, pool = createTestPool(), resetTable = true } = {}) {
  if (resetTable) await pool.query("DROP TABLE IF EXISTS payment_orders");
  const store = createPaymentStore({ pool });
  await store.ensureSchema();
  const payments = new Map();
  const createdOrders = [];
  const gatewayFactory = () => ({
    orders: {
      create: async order => {
        createdOrders.push(order);
        return {
          id: `order_unit_${createdOrders.length}`,
          amount: order.amount,
          currency: order.currency
        };
      }
    },
    payments: {
      fetch: async paymentId => {
        if (!payments.has(paymentId)) throw new Error("Payment not found in test gateway.");
        return payments.get(paymentId);
      }
    }
  });
  const app = createApp({ env, store, gatewayFactory });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    pool,
    gatewayFactory,
    payments,
    createdOrders,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      await pool.end();
    }
  };
}

async function postJson(baseUrl, route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

function signatureFor(orderId, paymentId) {
  return crypto.createHmac("sha256", credentials.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

test("publishes the five existing plans without exposing the Razorpay secret", async t => {
  const service = await createTestServer();
  t.after(service.close);

  const response = await fetch(`${service.baseUrl}/api/config`);
  const config = await response.json();
  assert.equal(config.configured, true);
  assert.equal(config.keyId, credentials.RAZORPAY_KEY_ID);
  assert.equal(JSON.stringify(config).includes(credentials.RAZORPAY_KEY_SECRET), false);
  assert.deepEqual(
    Object.fromEntries(config.plans.map(plan => [plan.id, plan.amount])),
    Object.fromEntries(Object.entries(PLANS).map(([id, plan]) => [id, plan.amountRupees]))
  );
});

test("creates idempotent orders with trusted prices instead of client amounts", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const idempotencyKey = crypto.randomUUID();

  const first = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey,
    amount: 1,
    currency: "USD"
  });
  const retry = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey,
    amount: 1
  });

  assert.equal(first.response.status, 201);
  assert.equal(first.data.amount, 2500);
  assert.equal(first.data.amountPaise, 250000);
  assert.equal(first.data.currency, "INR");
  assert.equal(first.data.orderId, retry.data.orderId);
  assert.equal(service.createdOrders.length, 1);
  assert.equal(service.createdOrders[0].amount, 250000);
  assert.equal(service.createdOrders[0].currency, "INR");
  assert.equal(service.createdOrders[0].receipt.length <= 40, true);
  assert.equal(typeof first.data.accessToken, "string");
});

test("uses the complete-course price in the payment page, Razorpay order, and payment summary", async t => {
  const service = await createTestServer();
  t.after(service.close);

  const plansResponse = await fetch(`${service.baseUrl}/api/config`);
  const plans = await plansResponse.json();
  assert.deepEqual(
    Object.fromEntries(plans.plans.map(plan => [plan.id, plan.amount])),
    {
      monthly: 2500,
      "three-months": 6500,
      "six-months": 12000,
      yearly: 18000,
      "complete-course": 25000
    }
  );

  const paymentsPage = await fetch(`${service.baseUrl}/payments.html`);
  const homePage = await fetch(`${service.baseUrl}/`);
  assert.match(await paymentsPage.text(), /<span class="price-amount">₹25,000<\/span>/);
  assert.match(await homePage.text(), /<strong>₹25,000<\/strong>/);

  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "complete-course",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.amount, 25000);
  assert.equal(created.data.amountPaise, 2500000);
  assert.equal(service.createdOrders[0].amount, 2500000);
  assert.equal(service.createdOrders[0].currency, "INR");

  const paymentId = "pay_unit_complete_course";
  service.payments.set(paymentId, {
    id: paymentId,
    order_id: created.data.orderId,
    amount: 2500000,
    currency: "INR",
    status: "captured"
  });
  const verification = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signatureFor(created.data.orderId, paymentId)
  });
  const summaryResponse = await fetch(`${service.baseUrl}/api/orders/${created.data.orderId}`, {
    headers: { "X-Order-Token": created.data.accessToken }
  });
  const summary = await summaryResponse.json();

  assert.equal(verification.response.status, 200);
  assert.equal(verification.data.status, "verified");
  assert.equal(summary.amount, 25000);
  assert.equal(summary.amountPaise, 2500000);
});

test("rejects unknown plans and reports missing credentials without opening checkout", async t => {
  const service = await createTestServer({ env: {} });
  t.after(service.close);

  const configResponse = await fetch(`${service.baseUrl}/api/config`);
  const config = await configResponse.json();
  const order = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  const invalidPlan = await postJson(service.baseUrl, "/api/orders", {
    planId: "made-up",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(config.configured, false);
  assert.equal(config.keyId, "");
  assert.equal(order.response.status, 503);
  assert.match(order.data.error, /not configured/i);
  assert.equal(service.createdOrders.length, 0);
  assert.equal(invalidPlan.response.status, 503); // gateway configuration is checked first
});

test("verifies the Razorpay signature and captured payment before returning success", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const idempotencyKey = crypto.randomUUID();
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "three-months",
    idempotencyKey
  });
  const paymentId = "pay_unit_captured";
  service.payments.set(paymentId, {
    id: paymentId,
    order_id: created.data.orderId,
    amount: 650000,
    currency: "INR",
    status: "captured"
  });
  const verification = {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signatureFor(created.data.orderId, paymentId)
  };

  const verified = await postJson(service.baseUrl, "/api/payments/verify", verification);
  const duplicate = await postJson(service.baseUrl, "/api/payments/verify", verification);
  const resultResponse = await fetch(`${service.baseUrl}/api/orders/${created.data.orderId}`, {
    headers: { "X-Order-Token": created.data.accessToken }
  });
  const result = await resultResponse.json();

  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.status, "verified");
  assert.equal(verified.data.paymentReference, paymentId);
  assert.equal(duplicate.data.status, "verified");
  assert.equal(result.status, "verified");
  assert.equal(result.amount, 6500);
  assert.equal(result.paymentReference, paymentId);
});

test("rejects forged signatures before contacting Razorpay", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  const invalid = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: "pay_forged",
    razorpay_signature: "0".repeat(64)
  });

  assert.equal(invalid.response.status, 400);
  assert.match(invalid.data.error, /signature/i);
  assert.equal(service.payments.size, 0);
});

test("does not confirm authorized payments or amounts that differ from the order", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "yearly",
    idempotencyKey: crypto.randomUUID()
  });
  const paymentId = "pay_unit_authorized";
  const authorizedPayment = {
    id: paymentId,
    order_id: created.data.orderId,
    amount: 1800000,
    currency: "INR",
    status: "authorized"
  };
  service.payments.set(paymentId, authorizedPayment);
  const authorized = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signatureFor(created.data.orderId, paymentId)
  });
  const wrongAmountId = "pay_unit_wrong_amount";
  service.payments.set(wrongAmountId, { ...authorizedPayment, id: wrongAmountId, amount: 1, status: "captured" });
  const wrongAmount = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: wrongAmountId,
    razorpay_signature: signatureFor(created.data.orderId, wrongAmountId)
  });

  assert.equal(authorized.response.status, 409);
  assert.match(authorized.data.error, /not captured/i);
  assert.equal(wrongAmount.response.status, 400);
  assert.match(wrongAmount.data.error, /do not match/i);
  const { rows } = await service.pool.query("SELECT status FROM payment_orders WHERE razorpay_order_id = $1", [created.data.orderId]);
  assert.equal(rows[0].status, "created");
});

test("requires the order token to read or cancel a payment", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "complete-course",
    idempotencyKey: crypto.randomUUID()
  });

  const denied = await fetch(`${service.baseUrl}/api/orders/${created.data.orderId}`);
  const cancelled = await postJson(
    service.baseUrl,
    `/api/orders/${created.data.orderId}/cancel`,
    {},
    { "X-Order-Token": created.data.accessToken }
  );
  const result = await fetch(`${service.baseUrl}/api/orders/${created.data.orderId}`, {
    headers: { "X-Order-Token": created.data.accessToken }
  });

  assert.equal(denied.status, 404);
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal((await result.json()).status, "cancelled");
});

test("serves payment results and never serves the private environment file", async t => {
  const service = await createTestServer();
  t.after(service.close);

  const resultPage = await fetch(`${service.baseUrl}/payment-result.html`);
  const environmentFile = await fetch(`${service.baseUrl}/.env`);
  assert.equal(resultPage.status, 200);
  assert.equal((await resultPage.text()).includes("Checking your payment"), true);
  assert.notEqual(environmentFile.status, 200);
});

// ---------------------------------------------------------------------------
// Vercel / serverless deployment regression tests
// ---------------------------------------------------------------------------

test("rejects an unknown plan with 400 when Razorpay is configured", async t => {
  const service = await createTestServer();
  t.after(service.close);

  const invalidPlan = await postJson(service.baseUrl, "/api/orders", {
    planId: "made-up",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(invalidPlan.response.status, 400);
  assert.equal(service.createdOrders.length, 0);
});

test("serves only /public: source code, package files and tests are not downloadable", async t => {
  const service = await createTestServer();
  t.after(service.close);

  const home = await fetch(`${service.baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Bhagath Yoga/i);

  for (const privatePath of ["/server.js", "/package.json", "/lib/payment-store.js", "/tests/server.test.js", "/.env", "/.env.local"]) {
    const response = await fetch(`${service.baseUrl}${privatePath}`);
    assert.notEqual(response.status, 200, `${privatePath} must not be served`);
  }
  for (const staticPath of ["/style.css", "/script.js", "/motion.js", "/site-config.js", "/payments.html", "/payments.js", "/assets/logo.jpeg"]) {
    const response = await fetch(`${service.baseUrl}${staticPath}`);
    assert.equal(response.status, 200, `${staticPath} must be served`);
  }
});

test("payment records survive across separate app instances (serverless instances share no memory or disk)", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(created.response.status, 201);

  // A brand-new app + store object (like a cold-started Vercel instance) on the same database.
  const secondStore = createPaymentStore({ pool: service.pool });
  const secondApp = createApp({ env: credentials, store: secondStore, gatewayFactory: service.gatewayFactory });
  const secondServer = secondApp.listen(0, "127.0.0.1");
  await new Promise(resolve => secondServer.once("listening", resolve));
  t.after(() => new Promise(resolve => secondServer.close(resolve)));

  const otherInstanceUrl = `http://127.0.0.1:${secondServer.address().port}`;
  const result = await fetch(`${otherInstanceUrl}/api/orders/${created.data.orderId}`, {
    headers: { "X-Order-Token": created.data.accessToken }
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).planId, "monthly");
});

test("simultaneous requests with one idempotency key create exactly one Razorpay order", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const idempotencyKey = crypto.randomUUID();

  const results = await Promise.all(
    Array.from({ length: 5 }, () => postJson(service.baseUrl, "/api/orders", { planId: "yearly", idempotencyKey }))
  );

  assert.equal(service.createdOrders.length, 1);
  assert.equal(results.filter(result => result.response.status === 201).length, 1);
  for (const { response } of results) assert.ok([200, 201, 409].includes(response.status));
  const { rows } = await service.pool.query("SELECT count(*)::int AS n FROM payment_orders");
  assert.equal(rows[0].n, 1);
});

test("never contacts Razorpay when payment storage is not configured", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const createdOrders = [];
  const app = createApp({
    env: credentials,
    store: createPaymentStore({}), // no DATABASE_URL, no pool
    gatewayFactory: () => ({ orders: { create: async order => { createdOrders.push(order); return {}; } } })
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  const order = await postJson(baseUrl, "/api/orders", { planId: "monthly", idempotencyKey: crypto.randomUUID() });

  assert.equal(config.plans.length, 5); // the plans page still loads without a database
  assert.equal(order.response.status, 503);
  assert.match(order.data.error, /storage is not configured/i);
  assert.equal(createdOrders.length, 0);
});

test("a failed order creation is recorded and the same key cannot be reused", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const idempotencyKey = crypto.randomUUID();
  const failingApp = createApp({
    env: credentials,
    store: service.store,
    gatewayFactory: () => ({ orders: { create: async () => { throw new Error("gateway down"); } } })
  });
  const server = failingApp.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const first = await postJson(baseUrl, "/api/orders", { planId: "monthly", idempotencyKey });
  const retry = await postJson(baseUrl, "/api/orders", { planId: "monthly", idempotencyKey });

  assert.equal(first.response.status, 502);
  assert.equal(retry.response.status, 409);
  const { rows } = await service.pool.query("SELECT status FROM payment_orders WHERE idempotency_key = $1", [idempotencyKey]);
  assert.equal(rows[0].status, "creation_failed");
});

test("a verified order is never downgraded by a later failure report", async t => {
  const service = await createTestServer();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", { planId: "monthly", idempotencyKey: crypto.randomUUID() });
  const paymentId = "pay_unit_ok";
  service.payments.set(paymentId, { id: paymentId, order_id: created.data.orderId, amount: 250000, currency: "INR", status: "captured" });
  const verified = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signatureFor(created.data.orderId, paymentId)
  });
  assert.equal(verified.data.status, "verified");

  service.payments.set("pay_unit_late_fail", { id: "pay_unit_late_fail", order_id: created.data.orderId, amount: 250000, currency: "INR", status: "failed" });
  await postJson(service.baseUrl, "/api/payments/failure", { orderId: created.data.orderId, paymentId: "pay_unit_late_fail" });

  const { rows } = await service.pool.query("SELECT status, razorpay_payment_id FROM payment_orders WHERE razorpay_order_id = $1", [created.data.orderId]);
  assert.equal(rows[0].status, "verified");
  assert.equal(rows[0].razorpay_payment_id, paymentId);
});

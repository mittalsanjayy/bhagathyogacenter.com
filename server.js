"use strict";

const path = require("node:path");

// Load local-development variables (.env.local wins over .env). On Vercel there is no .env
// file and the dashboard's environment variables are already in process.env, so this is a no-op.
require("dotenv").config({
  path: [path.join(__dirname, ".env.local"), path.join(__dirname, ".env")],
  quiet: true
});

const crypto = require("node:crypto");
const express = require("express");
const Razorpay = require("razorpay");
const { HttpError } = require("./lib/http-error");
const { createPaymentStore } = require("./lib/payment-store");

// All static files (HTML, CSS, JS, images) live in /public. On Vercel the CDN serves
// that folder directly; express.static below is only used for local `npm start`.
const PUBLIC_DIR = path.join(__dirname, "public");
const PLANS = Object.freeze({
  monthly: Object.freeze({ name: "Monthly membership", amountRupees: 2500 }),
  "three-months": Object.freeze({ name: "3-month membership", amountRupees: 6500 }),
  "six-months": Object.freeze({ name: "6-month membership", amountRupees: 12000 }),
  yearly: Object.freeze({ name: "Yearly membership", amountRupees: 18000 }),
  "complete-course": Object.freeze({ name: "Complete Yoga and Fitness course", amountRupees: 25000 })
});

function getCredentials(env) {
  const keyId = typeof env.RAZORPAY_KEY_ID === "string" ? env.RAZORPAY_KEY_ID.trim() : "";
  const keySecret = typeof env.RAZORPAY_KEY_SECRET === "string" ? env.RAZORPAY_KEY_SECRET.trim() : "";
  const keyIdIsValid = /^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId);
  const keySecretIsValid = keySecret.length > 0 && keySecret !== "YOUR_RAZORPAY_KEY_SECRET";

  return {
    configured: keyIdIsValid && keySecretIsValid,
    keyId: keyIdIsValid ? keyId : "",
    keySecret
  };
}

function createOrderToken(keySecret, idempotencyKey) {
  return crypto.createHmac("sha256", keySecret).update(`order-access:${idempotencyKey}`).digest("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest();
}

function tokenMatches(token, storedHash) {
  if (typeof token !== "string" || !storedHash) return false;
  const candidate = hashToken(token);
  const saved = Buffer.from(storedHash, "hex");
  return candidate.length === saved.length && crypto.timingSafeEqual(candidate, saved);
}

function isValidIdempotencyKey(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toPublicOrder(order) {
  return {
    orderId: order.razorpay_order_id,
    planId: order.plan_id,
    planName: order.plan_name,
    amount: order.amount_paise / 100,
    amountPaise: order.amount_paise,
    currency: "INR",
    status: order.status
  };
}

function requireGateway(env) {
  const credentials = getCredentials(env);
  if (!credentials.configured) {
    throw new HttpError(503, "Razorpay is not configured. Add your approved Test Mode or Live Mode credentials to the project environment variables and restart or redeploy.");
  }
  return credentials;
}

function createApp({
  env = process.env,
  store = createPaymentStore({ connectionString: env.DATABASE_URL || env.POSTGRES_URL }),
  gatewayFactory = credentials => new Razorpay({ key_id: credentials.keyId, key_secret: credentials.keySecret })
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(express.json({ limit: "10kb" }));

  app.get("/api/config", (req, res) => {
    const credentials = getCredentials(env);
    res.json({
      configured: credentials.configured,
      keyId: credentials.configured ? credentials.keyId : "",
      plans: Object.entries(PLANS).map(([id, plan]) => ({
        id,
        name: plan.name,
        amount: plan.amountRupees,
        currency: "INR"
      }))
    });
  });

  // Order an existing idempotency key already maps to: same behaviour for retries.
  function respondWithExistingOrder(res, order, planId, credentials, accessToken) {
    if (order.plan_id !== planId) {
      throw new HttpError(409, "This payment request was already used for a different plan. Start a new payment attempt.");
    }
    if (order.status === "created" || order.status === "verified") {
      return res.json({ ...toPublicOrder(order), keyId: credentials.keyId, accessToken });
    }
    if (order.status === "creating") {
      throw new HttpError(409, "This payment order is still being prepared. Please wait a moment and try again.");
    }
    throw new HttpError(409, "This payment request is no longer available. Start a new payment attempt.");
  }

  app.post("/api/orders", async (req, res) => {
    const credentials = requireGateway(env);
    const { planId, idempotencyKey } = req.body || {};
    if (typeof planId !== "string" || !Object.hasOwn(PLANS, planId)) {
      throw new HttpError(400, "Choose a valid membership or course.");
    }
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new HttpError(400, "A valid payment request ID is required. Please try again.");
    }

    const plan = PLANS[planId];
    const accessToken = createOrderToken(credentials.keySecret, idempotencyKey);

    const existing = await store.findByIdempotencyKey(idempotencyKey);
    if (existing) return respondWithExistingOrder(res, existing, planId, credentials, accessToken);

    // The durable record is written BEFORE Razorpay is contacted, so a Razorpay
    // order is never created without a stored record of it.
    const receipt = `bhg_${crypto.randomUUID().replaceAll("-", "")}`;
    let order = await store.insertCreating({
      idempotencyKey,
      tokenHash: hashToken(accessToken).toString("hex"),
      planId,
      planName: plan.name,
      amountPaise: plan.amountRupees * 100,
      receipt
    });

    if (!order) {
      // A concurrent request with the same key inserted first (possible across serverless instances).
      const raced = await store.findByIdempotencyKey(idempotencyKey);
      if (!raced) throw new Error("Payment order record could not be created.");
      return respondWithExistingOrder(res, raced, planId, credentials, accessToken);
    }

    try {
      const gateway = gatewayFactory(credentials);
      const gatewayOrder = await gateway.orders.create({
        amount: plan.amountRupees * 100,
        currency: "INR",
        receipt,
        notes: { plan_id: planId, center: "Bhagath Yoga Center" }
      });

      if (
        typeof gatewayOrder.id !== "string" ||
        gatewayOrder.amount !== plan.amountRupees * 100 ||
        gatewayOrder.currency !== "INR"
      ) {
        throw new Error("Razorpay returned an order with unexpected details.");
      }

      order = await store.markCreated(idempotencyKey, gatewayOrder.id);
      if (!order) throw new Error("Payment order record changed while the order was being created.");
      res.status(201).json({ ...toPublicOrder(order), keyId: credentials.keyId, accessToken });
    } catch (error) {
      try {
        await store.markCreationFailed(idempotencyKey);
      } catch (storeError) {
        console.error("Could not record order creation failure:", storeError.message);
      }
      throw error;
    }
  });

  app.post("/api/payments/verify", async (req, res) => {
    const credentials = requireGateway(env);
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (
      typeof orderId !== "string" || orderId.length > 64 ||
      typeof paymentId !== "string" || paymentId.length > 64 ||
      typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)
    ) {
      throw new HttpError(400, "Payment verification details are incomplete.");
    }

    const order = await store.findByRazorpayOrderId(orderId);
    if (!order) throw new HttpError(404, "This payment order could not be found.");

    const expectedSignature = crypto.createHmac("sha256", credentials.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest();
    const suppliedSignature = Buffer.from(signature, "hex");
    if (!crypto.timingSafeEqual(expectedSignature, suppliedSignature)) {
      throw new HttpError(400, "The payment signature could not be verified. No successful payment is confirmed.");
    }

    if (order.status === "verified") {
      if (order.razorpay_payment_id !== paymentId) {
        throw new HttpError(409, "A different payment has already been confirmed for this order.");
      }
      return res.json({ status: "verified", order: toPublicOrder(order), paymentReference: paymentId });
    }

    const gateway = gatewayFactory(credentials);
    const payment = await gateway.payments.fetch(paymentId);
    if (
      payment.order_id !== orderId ||
      payment.amount !== order.amount_paise ||
      payment.currency !== "INR"
    ) {
      throw new HttpError(400, "The payment details do not match this order. No successful payment is confirmed.");
    }

    if (payment.status !== "captured") {
      if (payment.status === "failed") {
        await store.markFailed(orderId, paymentId);
        return res.status(422).json({ status: "failed", error: "Razorpay reports that this payment failed. No enrollment is confirmed." });
      }
      throw new HttpError(409, "Razorpay has not captured this payment yet. No successful payment is confirmed.");
    }

    const updated = await store.markVerified(orderId, paymentId);
    const currentOrder = updated || await store.findByRazorpayOrderId(orderId);
    if (!updated && currentOrder.razorpay_payment_id !== paymentId) {
      throw new HttpError(409, "A different payment has already been confirmed for this order.");
    }
    res.json({ status: "verified", order: toPublicOrder(currentOrder), paymentReference: paymentId });
  });

  app.post("/api/payments/failure", async (req, res) => {
    const credentials = requireGateway(env);
    const { orderId, paymentId } = req.body || {};
    if (
      typeof orderId !== "string" || orderId.length > 64 ||
      typeof paymentId !== "string" || paymentId.length > 64
    ) {
      throw new HttpError(400, "Payment failure details are incomplete.");
    }

    const order = await store.findByRazorpayOrderId(orderId);
    if (!order) throw new HttpError(404, "This payment order could not be found.");

    const gateway = gatewayFactory(credentials);
    const payment = await gateway.payments.fetch(paymentId);
    if (
      payment.order_id !== orderId ||
      payment.amount !== order.amount_paise ||
      payment.currency !== "INR" ||
      payment.status !== "failed"
    ) {
      throw new HttpError(409, "Razorpay has not confirmed a failed payment for this order.");
    }

    await store.markFailed(orderId, paymentId);
    res.json({ status: "failed" });
  });

  app.post("/api/orders/:orderId/cancel", async (req, res) => {
    requireGateway(env);
    const order = await store.findByRazorpayOrderId(req.params.orderId);
    if (!order || !tokenMatches(req.get("X-Order-Token"), order.order_token_hash)) {
      throw new HttpError(404, "This payment order could not be found.");
    }

    await store.markCancelled(req.params.orderId);
    const updatedOrder = await store.findByRazorpayOrderId(req.params.orderId);
    res.json({ ...toPublicOrder(updatedOrder), paymentReference: updatedOrder.razorpay_payment_id || "" });
  });

  app.get("/api/orders/:orderId", async (req, res) => {
    requireGateway(env);
    const order = await store.findByRazorpayOrderId(req.params.orderId);
    if (!order || !tokenMatches(req.get("X-Order-Token"), order.order_token_hash)) {
      throw new HttpError(404, "This payment order could not be found.");
    }
    res.json({
      ...toPublicOrder(order),
      paymentReference: order.razorpay_payment_id || "",
      verifiedAt: order.verified_at
    });
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
  });

  // Local `npm start` only. Vercel ignores express.static and serves /public from its CDN.
  // Serving ONLY /public (never the project root) keeps server.js, package.json, tests/
  // and any dotfiles from ever being downloadable.
  app.use(express.static(PUBLIC_DIR, { dotfiles: "deny", index: "index.html" }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Payment server request failed:", error.message);
    res.status(502).json({ error: "The payment service could not complete this request. Please try again or contact the center." });
  });

  app.locals.store = store;
  return app;
}

// The exported value IS the Express app, which is what Vercel's zero-config Express
// runtime looks for. The named helpers are attached so tests can still import them.
const app = createApp();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Bhagath Yoga Center is available at http://localhost:${port}`);
    if (!getCredentials(process.env).configured) {
      console.warn("Razorpay is not configured. Add approved credentials to .env to enable checkout.");
    }
    if (!app.locals.store.isConfigured()) {
      console.warn("DATABASE_URL is not set. The website will load, but payments cannot be recorded.");
    }
  });
  server.on("close", () => app.locals.store.close());
}

module.exports = Object.assign(app, {
  PLANS,
  createApp,
  createOrderToken,
  createPaymentStore,
  getCredentials
});

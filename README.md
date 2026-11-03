# Bhagath Yoga Center

Responsive website for Bhagath Yoga Center. The pages use HTML, CSS, JavaScript, and local images (all in `public/`); the payment page also requires the Node.js/Express backend (`server.js`) and a PostgreSQL database, described below.

## Run the website

Install Node.js 22, open a terminal in the project root, and run:

```powershell
npm install
npm start
```

Open `http://localhost:3000/` or `http://localhost:3000/payments.html`. Locally, the Node server serves the `public/` folder and the payment API together (on Vercel, `public/` is served by the CDN and `server.js` runs as the API function). Do not use `python -m http.server` or a `file://` preview for payments: those do not provide the secure order-creation or verification endpoints. Stop the server with Ctrl+C.

## Razorpay configuration and testing

1. Copy `.env.example` to `.env` in the project root:

   ```powershell
   Copy-Item .env.example .env
   ```

2. In `.env`, set `DATABASE_URL` to a PostgreSQL connection string (a free Neon database, or a local Postgres), run `npm run db:init` once, then replace `YOUR_RAZORPAY_KEY_ID` with the Key ID from **Razorpay Dashboard → Test Mode → Account & Settings → API Keys**, and `YOUR_RAZORPAY_KEY_SECRET` with its matching Key Secret. Keep the two values from the same mode. Restart `npm start` after changing credentials.
3. Use the existing plan buttons on `/payments.html`. The server sets the INR amount from its private plan catalog; the browser cannot choose the order amount. Razorpay Checkout offers the payment methods enabled for the account.
4. Make a real Test Mode checkout using Razorpay's current official test payment details. Confirm that the browser returns to `payment-result.html` and that the server reports success only after verifying the signature and checking Razorpay for a captured payment. Also test a declined/failed attempt and closing Checkout. Test Mode payments do not move real funds.
5. Run the local backend checks with `npm test`.

The Key ID is public and is returned to Checkout only when valid credentials are configured. The Key Secret is read only by the backend and must never be copied into HTML, JavaScript, source control, or a frontend environment variable. `.env`, `.env.local` and every other `.env.*` file except `.env.example` are excluded by `.gitignore`. `.env.example` contains placeholders only.

Without credentials, the site still runs and shows a clear setup message; it does not simulate or confirm a payment. Replace the placeholders only after your Razorpay account is approved.

Payment records (order, plan, amount, status, Razorpay references) are stored in a PostgreSQL table, `payment_orders`, named by `DATABASE_URL`. Serverless functions have no permanent disk and each instance has its own temporary one, so payment records must never be written to a local file (such as SQLite in `/tmp`). Use a managed database and back it up according to your provider's tools. `npm run db:init` creates the table (it also creates itself on first use). Run `npm test` for the backend checks; set `TEST_DATABASE_URL` to also run them against a real PostgreSQL database.

### Switch to Live Mode

After account approval, replace both Test Mode values with the matching **Live Mode** Key ID and Key Secret in `.env` (or the Vercel Environment Variables page), then redeploy the backend. Live Key IDs start with `rzp_live_`; test IDs start with `rzp_test_`. Never mix a Key ID and Key Secret from different modes. Repeat a small real payment check and confirm the server-side verified status before using the live checkout operationally.

## Shared business configuration

Update existing business details in `site-config.js`:

- `contactEmail`: currently `vrshkanthi@gmail.com`
- `address`, `streetAddress`, `addressLocality`, `addressRegion`, and `postalCode`: currently Kulla Appa Circle, HRBR Layout, Kalyan Nagar, Bengaluru (560043)
- `phoneDisplay` and `whatsappPhone`: existing center phone
- `instagramUrl`: existing Instagram page
- `verifiedUpiId` and `verifiedUpiPayeeName`: the owner-provided UPI details

The homepage contact links, directions, structured data, payment-page email/phone/social links, and address display read from this configuration. No replacement email or address has been supplied; the values above are retained until the owner updates them here.

## Pages, plans, and timetable

- `index.html` is the homepage; `payments.html` is the plans and payments page.
- `script.js` renders the confirmed six Monday–Friday class times, weekday/session filters, enquiry validation, and image lightbox.
- `motion.js` adds optional GSAP/ScrollTrigger reveals, hero parallax, image transitions, and desktop-only CTA response. If GSAP is unavailable, it falls back to native scroll reveals; without animation support, content remains visible.
- `server.js` owns the trusted catalog for the five existing plans and creates Razorpay orders, verifies the Checkout signature, checks the payment is captured for the expected amount/order, and stores order status/payment references in PostgreSQL (`lib/payment-store.js`).
- `payments.js` connects every existing plan button to Standard Checkout. `payment-result.html` and `payment-result.js` display success only after backend verification; failure, cancellation, and pending results are also explicit.
- The server plan catalog uses these amounts: monthly ₹2,500, 3 months ₹6,500, 6 months ₹12,000, yearly ₹18,000, and Complete Yoga and Fitness course ₹25,000. Amounts are sent to Razorpay in paise by the backend.
- All local photos are in `public/assets/`. Preserve the directory and filenames when copying, deploying, or packaging the project. This includes `new.png`, `testimony.png`, `testimony2.png`, `testimony3.png`, and legacy-spelled files such as `secound.jpeg` and `fouth.jpeg`.

Payment success is not inferred from a browser callback alone. The server verifies Razorpay's HMAC signature and fetches the payment from Razorpay to confirm it is captured, for the matching order and exact server-side amount. Payment references and statuses are stored in the PostgreSQL database; access to a result requires a per-order token kept in the browser's session storage.

## Contact form behavior

The homepage enquiry form and free-demo request form validate visitor details and submit through the official `@emailjs/browser` client. The EmailJS service, template, public key, and fixed recipient are configured in `public/emailjs-config.js`. The homepage submits `name`, `email`, `phone`, `interest`, `message`, and `to_email`; the existing EmailJS template's **To Email** field is configured directly with the recipient and its **Reply To** field uses `{{email}}`. The demo form also uses this template and supplies its named form fields. The public key is intended for browser use; never add a private EmailJS key or secret to the public files.

## Deploying to GitHub and Vercel

Project layout (what Vercel needs):

- `public/` - every static file: HTML, CSS, JS and `assets/`. Vercel serves this folder from its CDN. (`express.static()` is ignored on Vercel, which is why files outside `public/` gave `Cannot GET /`.)
- `server.js` - the Express app. It imports `express` and exports the app, so Vercel runs it as one serverless function for `/api/*`.
- `lib/payment-store.js` - PostgreSQL storage for payment records.

One-time setup:

1. Push the code to GitHub (commands below) and import the repository in Vercel.
2. In the Vercel project, open **Storage** and add **Neon (Postgres)** from the Marketplace. Vercel injects `DATABASE_URL` for you.
3. Open **Settings -> Environment Variables** and add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` for Production (and Preview if you want to test there). Use Test Mode keys first. Never put these in the repository.
4. Create the table once: `vercel env pull .env.local` then `npm run db:init`.
5. Redeploy (environment variables apply to new deployments only).

Check after deploying: `/` shows the homepage, `/api/config` returns JSON with `"configured": true`, and `/server.js` and `/package.json` return 404.

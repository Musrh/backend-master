import express from "express";
import cors from "cors";
import Stripe from "stripe";
import dotenv from "dotenv";
import admin from "firebase-admin";
import bodyParser from "body-parser";

dotenv.config();

const app = express();

// ================= CORS =================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));

// ================= FIREBASE =================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ================= STRIPE =================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ================= FRONTEND SAAS =================
const FRONTEND_URL = "https://musrh.github.io/SaasBuilder";

// ================= WEBHOOK STRIPE =================
// ⚠️ IMPORTANT: raw body must be before express.json()
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {

    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ================= PAYMENT SUCCESS =================
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      console.log("💰 PAYMENT SUCCESS:", session.id);

      if (session.payment_status === "paid") {

        // 🔐 anti doublon
        const existing = await db
          .collection("orders")
          .where("sessionId", "==", session.id)
          .get();

        if (!existing.empty) {
          console.log("⚠️ Order already exists");
          return res.json({ received: true });
        }

        // ================= METADATA =================
        let metadata = {};

        try {
          metadata = session.metadata?.data
            ? JSON.parse(session.metadata.data)
            : {};
        } catch (e) {
          console.log("⚠️ metadata parse error");
        }

        // ================= FIRESTORE SAVE =================
        await db.collection("orders").doc(session.id).set({
          email: session.customer_email || metadata.email || "",
          items: metadata.items || [],
          montant: session.amount_total / 100,
          adresse: metadata.adresseLivraison || "",
          clientId: metadata.clientId || "master",
          plan: metadata.plan || "basic",
          paymentMethod: "stripe",
          sessionId: session.id,
          status: "paid",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log("✅ Order saved with sessionId doc");
      }
    }

    res.json({ received: true });
  }
);

// ================= JSON MIDDLEWARE =================
app.use(express.json());

// ================= CREATE STRIPE SESSION =================
app.post("/create-stripe-session", async (req, res) => {
  try {
    const {
      items,
      email,
      adresseLivraison,
      clientId,
      plan
    } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,

      line_items: items.map((item) => ({
        price_data: {
          currency: "eur",
          product_data: {
            name: item.nom,
          },
          unit_amount: Math.round(item.prix * 100),
        },
        quantity: item.quantity,
      })),

      mode: "payment",

      // ================= SAAS FRONTEND =================
      success_url:
        `${FRONTEND_URL}/#/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url:
        `${FRONTEND_URL}/#/cancel`,

      // ================= METADATA SAAS =================
      metadata: {
        data: JSON.stringify({
          items,
          adresseLivraison,
          email,
          clientId: clientId || "master",
          plan: plan || "basic",
        }),
      },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Stripe session error:", err.message);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// ================= HEALTH CHECK =================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "SaaS Master Backend",
    frontend: FRONTEND_URL,
    backend: "https://backend-master-production-cf50.up.railway.app"
  });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("🚀 SaaS Master running on port", PORT);
  console.log("🌍 Frontend:", FRONTEND_URL);
  console.log("⚡ Backend ready:", "https://backend-master-production-cf50.up.railway.app");
});

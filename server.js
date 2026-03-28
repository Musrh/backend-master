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

// ================= FRONTEND =================
const FRONTEND_URL = "https://musrh.github.io/SaasBuilder";

// ================= WEBHOOK =================
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

        // 🔐 Anti doublon
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

        // ================= SAVE FIRESTORE =================
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

        console.log("✅ Order saved:", session.id);
      }
    }

    res.json({ received: true });
  }
);

// ================= JSON =================
app.use(express.json());

// ================= CREATE SESSION =================
app.post("/create-stripe-session", async (req, res) => {
  try {
    const {
      items,
      email,
      adresseLivraison,
      clientId,
      plan
    } = req.body;

    const finalPlan = plan || "basic";

    // 🔥 URL dynamique avec plan
    const successUrl =
      `${FRONTEND_URL}/#/success?plan=${finalPlan}&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl =
      `${FRONTEND_URL}/#/cancel`;

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

      success_url: successUrl,
      cancel_url: cancelUrl,

      metadata: {
        data: JSON.stringify({
          items,
          adresseLivraison,
          email,
          clientId: clientId || "master",
          plan: finalPlan,
        }),
      },
    });

    console.log("🧾 Session créée:", session.id, "Plan:", finalPlan);

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Stripe session error:", err.message);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "SaaS Master Backend",
    frontend: FRONTEND_URL,
    backend: "https://backend-master-production-cf50.up.railway.app"
  });
});

// ================= START =================
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("🚀 SaaS Master running on port", PORT);
  console.log("🌍 Frontend:", FRONTEND_URL);
});

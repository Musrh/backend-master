// ================= BACKEND MASTER =================
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

// ================= FIREBASE SAFE INIT =================
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error("❌ Firebase service account JSON invalide");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ================= STRIPE =================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ================= FRONTEND =================
const FRONTEND_URL = "https://musrh.github.io/SaasBuilder";

// ================= JSON =================
app.use(express.json());

// ================= WEBHOOK STRIPE =================
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
        try {
          // 🔐 anti doublon
          const existing = await db
            .collection("orders")
            .where("sessionId", "==", session.id)
            .get();

          if (!existing.empty) {
            console.log("⚠️ Order déjà existante");
            return res.json({ received: true });
          }

          // ================= METADATA =================
          let metadata = {};

          try {
            metadata = session.metadata?.data
              ? JSON.parse(session.metadata.data)
              : {};
          } catch (e) {
            console.log("⚠️ Erreur parsing metadata");
          }

          const uid = metadata.clientId || "master";

          // ================= SAVE ORDER =================
          await db.collection("orders").doc(session.id).set({
            email: session.customer_email || metadata.email || "",
            items: metadata.items || [],
            montant: session.amount_total / 100,
            adresse: metadata.adresseLivraison || "",
            clientId: uid,
            plan: metadata.plan || "basic",
            paymentMethod: "stripe",
            sessionId: session.id,
            status: "paid",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // ================= SAVE SITE =================
          await db.collection("sites").doc(uid).set({
            userId: uid,
            plan: metadata.plan || "premium",
            sections: [
              { type: "hero", title: "Bienvenue" },
              { type: "text", content: "Mon site SaaS" }
            ],
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          console.log("✅ Order + Site sauvegardés:", session.id);

        } catch (err) {
          console.error("❌ Erreur webhook processing:", err);
        }
      }
    }

    res.json({ received: true });
  }
);

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

    // 🔥 VALIDATION PANIER
    if (!items || !items.length) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const finalPlan = plan || "basic";

    const successUrl =
      `${FRONTEND_URL}/#/success?plan=${finalPlan}&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl =
      `${FRONTEND_URL}/#/cancel`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email || undefined,

      line_items: items.map((item) => ({
        price_data: {
          currency: "eur",
          product_data: {
            name: item.nom || "Produit",
          },
          unit_amount: Math.round((item.prix || 0) * 100),
        },
        quantity: item.quantity || 1,
      })),

      mode: "payment",

      success_url: successUrl,
      cancel_url: cancelUrl,

      metadata: {
        data: JSON.stringify({
          items,
          adresseLivraison: adresseLivraison || "",
          email: email || "",
          clientId: clientId || "master",
          plan: finalPlan,
        }),
      },
    });

    console.log("🧾 Session Stripe créée:", session.id);

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Stripe session error:", err);
    res.status(500).json({
      error: "Stripe session failed",
      details: err.message
    });
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
});

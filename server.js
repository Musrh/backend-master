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
let serviceAccount = null;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error("❌ Firebase service account JSON invalide");
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else {
  console.error("❌ Firebase NON initialisé");
}

const db = admin.firestore();

// ================= STRIPE =================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ================= FRONTEND =================
const FRONTEND_URL = "https://musrh.github.io/SaasBuilder";

// ================= JSON =================
app.use(express.json());

// ================= DEBUG (IMPORTANT) =================
app.use((req, res, next) => {
  if (req.path === "/create-stripe-session") {
    console.log("📦 BODY REÇU =", req.body);
  }
  next();
});

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
          const existing = await db
            .collection("orders")
            .where("sessionId", "==", session.id)
            .get();

          if (!existing.empty) {
            console.log("⚠️ Order déjà existante");
            return res.json({ received: true });
          }

          // ================= METADATA SAFE =================
          let metadata = {};

          try {
            metadata = session.metadata?.data
              ? JSON.parse(session.metadata.data)
              : {};
          } catch (e) {
            console.log("⚠️ Metadata invalide");
          }

          const uid = metadata.clientId || "master";

          // ================= ORDER =================
          await db.collection("orders").doc(session.id).set({
            email: session.customer_email || metadata.email || "",
            items: metadata.items || [],
            montant: (session.amount_total || 0) / 100,
            adresse: metadata.adresseLivraison || "",
            clientId: uid,
            plan: metadata.plan || "basic",
            paymentMethod: "stripe",
            sessionId: session.id,
            status: "paid",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // ================= SITE =================
          await db.collection("sites").doc(uid).set({
            userId: uid,
            plan: metadata.plan || "premium",
            sections: [
              { type: "hero", title: "Bienvenue" },
              { type: "text", content: "Mon site SaaS" }
            ],
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          console.log("✅ ORDER + SITE OK:", session.id);

        } catch (err) {
          console.error("❌ Webhook error:", err);
        }
      }
    }

    res.json({ received: true });
  }
);

// ================= CREATE STRIPE SESSION =================
app.post("/create-stripe-session", async (req, res) => {
  try {
    let { items, email, adresseLivraison, clientId, plan } = req.body;

    // ================= NORMALISATION PANIER =================
    items = (items || []).map((item) => ({
      nom: item.nom || item.title || "Produit",
      prix: item.prix || item.price || 0,
      quantity: item.quantity || item.qty || 1,
    }));

    if (!items.length) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const finalPlan = plan || "basic";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email || undefined,

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

      success_url:
        `${FRONTEND_URL}/#/success?plan=${finalPlan}&session_id={CHECKOUT_SESSION_ID}`,

      cancel_url:
        `${FRONTEND_URL}/#/cancel`,

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

    console.log("🧾 Stripe session OK:", session.id);

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Stripe session error:", err);
    res.status(500).json({
      error: "Stripe session failed",
      details: err.message,
    });
  }
});

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "SaaS Master Backend",
    frontend: FRONTEND_URL,
  });
});

// ================= START =================
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("🚀 SaaS Master running on port", PORT);
});

// ===============================================================
//  server.js — Backend SaaasGenerator + Groq AI + Stripe
// ===============================================================

import express from "express"
import cors from "cors"
import Stripe from "stripe"
import dotenv from "dotenv"
import admin from "firebase-admin"
import bodyParser from "body-parser"
import Groq from "groq-sdk"

dotenv.config()

// ─────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────
const app = express()
const PORT = process.env.PORT || 8080

app.use(cors({ origin: "*", methods: ["GET", "POST"] }))

// ⚠️ IMPORTANT : on ne bloque PAS le webhook Stripe
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next()
  express.json()(req, res, next)
})

// ─────────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────────
let serviceAccount = null

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
} catch (e) {
  console.error("❌ Firebase service account JSON invalide")
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })
} else {
  console.error("❌ Firebase NON initialisé")
}

const db = admin.firestore()

// ─────────────────────────────────────────────
// STRIPE
// ─────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ─────────────────────────────────────────────
// GROQ
// ─────────────────────────────────────────────
const groq = new Groq({
  apiKey: process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY,
})

const FRONTEND_URL = "https://musrh.github.io/SaaasGenerator"

// ===============================================================
// DEBUG
// ===============================================================
app.use((req, res, next) => {
  if (req.path === "/create-stripe-session") {
    console.log("📦 BODY REÇU =", req.body)
  }
  next()
})

// ===============================================================
// STRIPE WEBHOOK (VERSION CONSERVÉE + SAFE)
// ===============================================================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"]

    let event

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (err) {
      console.error("❌ Webhook error:", err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    console.log("📩 Stripe event:", event.type)

    if (event.type === "checkout.session.completed") {
      const session = event.data.object

      console.log("💰 PAYMENT SUCCESS:", session.id)

      // ⚠️ on garde ton comportement original
      if (session.payment_status === "paid") {
        try {
          const existing = await db
            .collection("orders")
            .where("sessionId", "==", session.id)
            .get()

          if (!existing.empty) {
            console.log("⚠️ Order déjà existante")
            return res.json({ received: true })
          }

          let metadata = {}

          try {
            metadata = session.metadata?.data
              ? JSON.parse(session.metadata.data)
              : {}
          } catch (e) {
            console.warn("⚠️ metadata parse error")
          }

          const uid = metadata.clientId || "master"

          const orderData = {
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
          }

          await db.collection("orders").doc(session.id).set(orderData)

          console.log("✅ ORDER SAVED FIRESTORE:", session.id)
        } catch (err) {
          console.error("❌ Firestore error:", err)
        }
      }
    }

    res.json({ received: true })
  }
)

// ===============================================================
// STRIPE SESSION (inchangé)
// ===============================================================
app.post("/create-stripe-session", async (req, res) => {
  try {
    let {
      items,
      email,
      adresseLivraison,
      clientId,
      plan,
      successUrl,
      cancelUrl,
    } = req.body

    items = (items || []).map((item) => ({
      nom: item.nom || item.title || "Produit",
      prix: item.prix || item.price || 0,
      quantity: item.quantity || item.qty || 1,
    }))

    if (!items.length)
      return res.status(400).json({ error: "Panier vide" })

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email || undefined,

      line_items: items.map((item) => ({
        price_data: {
          currency: "eur",
          product_data: { name: item.nom },
          unit_amount: Math.round(item.prix * 100),
        },
        quantity: item.quantity,
      })),

      mode: "payment",

      success_url:
        successUrl ||
        `${FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: cancelUrl || `${FRONTEND_URL}/`,

      metadata: {
        data: JSON.stringify({
          items,
          adresseLivraison: adresseLivraison || "",
          email: email || "",
          clientId: clientId || "master",
          plan: plan || "basic",
        }),
      },
    })

    console.log("🧾 Stripe session OK:", session.id)

    res.json({ url: session.url })
  } catch (err) {
    console.error("❌ Stripe session error:", err)
    res.status(500).json({
      error: "Stripe session failed",
      details: err.message,
    })
  }
})

// ===============================================================
// ROOT
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "SaaasGenerator Backend",
    webhook: "stripe enabled",
    firestore: "orders enabled",
  })
})

// ===============================================================
// START SERVER
// ===============================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`)
})

// ===============================================================
//  server.js — SaaS Builder + Stripe + Firestore + Groq AI
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
const app = express()
const PORT = process.env.PORT || 8080

app.use(cors({ origin: "*", methods: ["GET", "POST"] }))
app.use(express.json())

// ─────────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────────
let serviceAccount = null
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
} catch (e) {
  console.error("❌ Firebase service account invalide")
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })
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
// 🔥 CREATE STRIPE SESSION (CORRIGÉ)
// ===============================================================
app.post("/create-stripe-session", async (req, res) => {
  try {
    let {
      items,
      email,
      adresseLivraison,
      clientId,
      ownerId,   // ⭐ AJOUT IMPORTANT
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
          product_data: {
            name: item.nom,
          },
          unit_amount: Math.round(item.prix * 100),
        },
        quantity: item.quantity,
      })),

      mode: "payment",
      success_url: successUrl || `${FRONTEND_URL}/#/success`,
      cancel_url: cancelUrl || `${FRONTEND_URL}/#/cart`,

      metadata: {
        data: JSON.stringify({
          items,
          email: email || "",
          adresseLivraison: adresseLivraison || "",
          clientId: clientId || "",
          ownerId: ownerId || "", // ⭐ IMPORTANT
          plan: plan || "basic",
        }),
      },
    })

    console.log("🧾 Stripe session créée:", session.id)

    res.json({ url: session.url })
  } catch (err) {
    console.error("❌ Stripe error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ===============================================================
// 🔥 WEBHOOK STRIPE (CORRIGÉ + FIRESTORE)
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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object

      console.log("💰 PAYMENT OK:", session.id)

      try {
        const metadata = session.metadata?.data
          ? JSON.parse(session.metadata.data)
          : {}

        const ownerId = metadata.ownerId || "unknown"
        const userId = metadata.clientId || session.customer_email || "unknown"

        // ❗ Vérification anti-doublon
        const existing = await db
          .collection("orders")
          .where("sessionId", "==", session.id)
          .get()

        if (!existing.empty) {
          console.log("⚠️ Commande déjà existante")
          return res.json({ received: true })
        }

        // 🔥 SAVE ORDER FIRESTORE
        await db.collection("orders").doc(session.id).set({
          sessionId: session.id,

          // 👤 client
          userId,
          email: session.customer_email || metadata.email || "",

          // 🏪 STORE OWNER (IMPORTANT)
          ownerId,

          items: metadata.items || [],
          total: (session.amount_total || 0) / 100,

          adresse: metadata.adresseLivraison || "",

          status: "pending",
          paymentMethod: "stripe",

          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        })

        console.log("✅ ORDER SAVED FIRESTORE")
      } catch (err) {
        console.error("❌ Firestore error:", err.message)
      }
    }

    res.json({ received: true })
  }
)

// ===============================================================
// 🔥 GET ORDERS (STORE)
// ===============================================================
app.get("/api/orders/:ownerId", async (req, res) => {
  try {
    const snap = await db
      .collection("orders")
      .where("ownerId", "==", req.params.ownerId)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get()

    const orders = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }))

    res.json({ orders, count: orders.length })
  } catch (e) {
    console.error(e.message)
    res.status(500).json({ error: e.message })
  }
})

// ===============================================================
// 🔥 HEALTH CHECK
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "SaaS Backend FIXED",
    firebase: !!serviceAccount,
    stripe: true,
  })
})

// ===============================================================
// 🔥 START SERVER
// ===============================================================
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT)
})

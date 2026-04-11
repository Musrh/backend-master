// ===============================================================
//  server.js — Backend SaaasGenerator + Assistant IA Groq
//  
//  Endpoints existants conservés :
//    POST /create-stripe-session
//    POST /webhook
//    GET  /
//
//  Nouveaux endpoints IA :
//    POST /api/assistant          → chat Groq + contexte Firestore
//    POST /api/save-request       → sauvegarder une requête non résolue
//    GET  /api/products/:storeUid → liste produits (prodinfos)
//    GET  /api/orders/:storeUid   → commandes (cmdinfos)
// ===============================================================

import express    from "express"
import cors       from "cors"
import Stripe     from "stripe"
import dotenv     from "dotenv"
import admin      from "firebase-admin"
import bodyParser from "body-parser"
import Groq       from "groq-sdk"

dotenv.config()

// ── App ──────────────────────────────────────────────────────
const app  = express()
const PORT = process.env.PORT || 8080

// ── CORS ─────────────────────────────────────────────────────
app.use(cors({ origin: "*", methods: ["GET", "POST"] }))

// ── Firebase Admin ────────────────────────────────────────────
let serviceAccount = null
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
} catch (e) {
  console.error("❌ Firebase service account JSON invalide")
}

if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
} else {
  console.error("❌ Firebase NON initialisé")
}

const db = admin.firestore()

// ── Stripe ────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ── Groq ──────────────────────────────────────────────────────
// Variable d'env : VITE_GROQ_API_KEY ou GROQ_API_KEY
const groq = new Groq({
  apiKey: process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY
})

const FRONTEND_URL = "https://musrh.github.io/SaaasGenerator"

// ── JSON middleware ───────────────────────────────────────────
app.use(express.json())

// ── Debug ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/create-stripe-session") {
    console.log("📦 BODY REÇU =", req.body)
  }
  next()
})


// ===============================================================
//  UTILITAIRES FIRESTORE
// ===============================================================

// Charger les produits du store
// Cherche dans prodinfos ET products (selon où les produits sont sauvegardés)
const getProduits = async (storeUid) => {
  try {
    let results = []

    // ── Tentative 1 : prodinfos filtré par storeUid ───────────
    if (storeUid) {
      try {
        const snap1 = await db.collection("prodinfos")
          .where("storeUid", "==", storeUid).limit(100).get()
        results = snap1.docs.map(d => ({ id: d.id, ...d.data() }))
        console.log(`📦 prodinfos(storeUid=${storeUid}): ${results.length} produits`)
      } catch(e1) { console.warn("prodinfos filtrée:", e1.message) }
    }

    // ── Tentative 2 : collection products filtré par storeUid ─
    // (AddProduct.vue écrit dans products/)
    if (results.length === 0 && storeUid) {
      try {
        const snap2 = await db.collection("products")
          .where("storeUid", "==", storeUid).limit(100).get()
        results = snap2.docs.map(d => ({ id: d.id, ...d.data() }))
        console.log(`📦 products(storeUid=${storeUid}): ${results.length} produits`)
      } catch(e2) { console.warn("products filtrée:", e2.message) }
    }

    // ── Tentative 3 : prodinfos sans filtre (fallback global) ─
    if (results.length === 0) {
      try {
        const snap3 = await db.collection("prodinfos").limit(100).get()
        results = snap3.docs.map(d => ({ id: d.id, ...d.data() }))
        console.log(`📦 prodinfos(global): ${results.length} produits`)
      } catch(e3) { console.warn("prodinfos global:", e3.message) }
    }

    // ── Tentative 4 : products sans filtre (fallback global) ──
    if (results.length === 0) {
      try {
        const snap4 = await db.collection("products").limit(100).get()
        results = snap4.docs.map(d => ({ id: d.id, ...d.data() }))
        console.log(`📦 products(global): ${results.length} produits`)
      } catch(e4) { console.warn("products global:", e4.message) }
    }

    // Normaliser les champs (les 2 collections ont des noms différents)
    results = results.map(p => ({
      id:          p.id,
      name:        p.name        || p.nom        || "Produit",
      price:       p.price       || p.prix        || 0,
      description: p.description || p.desc        || "",
      stock:       p.stock       !== undefined ? p.stock : "N/A",
      currency:    p.currency    || p.devise      || "€",
      badge:       p.badge       || "",
      storeUid:    p.storeUid    || storeUid,
    }))

    console.log(`✅ ${results.length} produits chargés pour storeUid=${storeUid || "global"}`)
    return results
  } catch (e) {
    console.error("❌ Erreur getProduits:", e.message)
    return []
  }
}

// Chercher les commandes client (collection cmdinfos ET orders)
const getCmdinfos = async (storeUid, { nom, email, date } = {}) => {
  try {
    let results = []

    // ── Chercher dans cmdinfos ─────────────────────────────
    try {
      let q = db.collection("cmdinfos")
      // Filtrer par email si fourni (index requis)
      if (email) q = q.where("customerEmail", "==", email.trim().toLowerCase())
      else if (storeUid) q = q.where("storeUid", "==", storeUid)
      const snap = await q.limit(20).get()
      results = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      console.log(`📋 cmdinfos: ${results.length} commandes`)
    } catch(e) { console.warn("cmdinfos query:", e.message) }

    // ── Fallback : chercher dans orders (collection racine) ─
    if (results.length === 0) {
      try {
        let q2 = db.collection("orders")
        if (email) q2 = q2.where("email", "==", email.trim().toLowerCase())
        else if (storeUid) q2 = q2.where("clientId", "==", storeUid)
        const snap2 = await q2.limit(20).get()
        const r2 = snap2.docs.map(d => ({
          id: d.id, ...d.data(),
          customerName:  d.data().customerName  || d.data().name || "",
          customerEmail: d.data().customerEmail || d.data().email || "",
        }))
        results = [...results, ...r2]
        console.log(`📋 orders (fallback): ${r2.length} commandes`)
      } catch(e) { console.warn("orders fallback query:", e.message) }
    }

    // ── Chercher aussi dans users/{storeUid}/orders ─────────
    if (storeUid) {
      try {
        let q3 = db.collection("users").doc(storeUid).collection("orders")
        if (email) q3 = q3.where("customerEmail", "==", email.trim().toLowerCase())
        const snap3 = await q3.limit(20).get()
        const r3 = snap3.docs.map(d => ({ id: d.id, ...d.data() }))
        // Dédupliquer
        const existingIds = new Set(results.map(r => r.id))
        results = [...results, ...r3.filter(r => !existingIds.has(r.id))]
        console.log(`📋 users/orders: ${r3.length} commandes`)
      } catch(e) { console.warn("users/orders query:", e.message) }
    }

    // ── Filtres client ─────────────────────────────────────
    if (nom) {
      const n = nom.toLowerCase()
      results = results.filter(r =>
        (r.customerName || r.name || "").toLowerCase().includes(n)
      )
    }
    if (date) {
      results = results.filter(r => {
        const d = r.createdAt?.toDate?.()?.toISOString?.() || String(r.createdAt || "")
        return d.includes(date)
      })
    }
    console.log(`📋 Total commandes trouvées: ${results.length}`)
    return results
  } catch (e) {
    console.error("❌ Erreur getCmdinfos:", e.message)
    return []
  }
}

// Sauvegarder une requête non résolue (collection requetes)
const saveRequete = async (storeUid, data) => {
  try {
    const ref = await db.collection("requetes").add({
      storeUid:  storeUid || "unknown",
      nom:       data.nom       || "",
      email:     data.email     || "",
      telephone: data.telephone || "",
      adresse:   data.adresse   || "",
      question:  data.question  || "",
      status:    "nouveau",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    console.log("✅ Requête sauvegardée:", ref.id)
    return ref.id
  } catch (e) {
    console.error("❌ Erreur save requete:", e.message)
    return null
  }
}

// Construire le contexte produits pour le prompt
const buildProduitsContext = (produits) => {
  if (!produits.length) return "Aucun produit disponible dans le catalogue du store."
  return produits.map(p => {
    const name  = p.name || p.nom || "Produit sans nom"
    const price = p.price || p.prix
    const priceFmt = price !== undefined && price !== null ? `${price}${p.currency || p.devise || "€"}` : "prix non défini"
    const desc  = p.description || p.desc || ""
    const stock = p.stock !== undefined ? `stock: ${p.stock}` : ""
    const badge = p.badge ? `[${p.badge}]` : ""
    return `- ${name} ${badge} | Prix: ${priceFmt} | ${desc}${stock ? " | " + stock : ""}`
  }).join("\n")
}

// Construire le contexte commandes pour le prompt
const buildCmdContext = (cmds) => {
  if (!cmds.length) return "Aucune commande trouvée avec ces informations."
  return cmds.map(c => {
    const statuts = {
      pending:   "En attente",
      paid:      "Payée — en cours de traitement",
      shipped:   "Expédiée — en route",
      delivered: "Livrée",
      cancelled: "Annulée",
      returned:  "Retour client",
      info_needed: "Renseignements supplémentaires requis",
    }
    const statut  = statuts[c.status] || c.status || "Inconnu"
    const date    = c.createdAt?.toDate?.()?.toLocaleDateString("fr-FR") || c.createdAt || "N/A"
    const items   = (c.items || []).map(i => `${i.name || i.nom} ×${i.qty || 1}`).join(", ")
    return `Commande #${c.id.slice(0,8).toUpperCase()} | Date: ${date} | Articles: ${items} | Total: ${c.total || c.montant || "N/A"}€ | Statut: ${statut} | Adresse: ${c.customerAddress || c.adresse || "non renseignée"}`
  }).join("\n")
}


// ===============================================================
//  ENDPOINT : POST /api/assistant
//  Chat avec l'assistant IA Groq
// ===============================================================
app.post("/api/assistant", async (req, res) => {
  const {
    message,        // message du client
    history = [],   // historique de la conversation [ {role, content} ]
    storeUid,       // uid du propriétaire du store
    storeEmail,     // email du store (pour fallback)
    storeName,      // nom du store
    lang = "fr",    // langue
    clientInfo = {} // { nom, email, date } si déjà renseigné
  } = req.body

  if (!message) return res.status(400).json({ error: "message requis" })

  try {
    // ── 1. Charger le contexte Firestore ───────────────────────
    console.log(`🤖 Assistant appelé | storeUid=${storeUid} | lang=${lang} | msg="${message.slice(0,50)}"`)
    const [produits, cmds] = await Promise.all([
      getProduits(storeUid),
      (clientInfo.email || clientInfo.nom)
        ? getCmdinfos(storeUid, clientInfo)
        : Promise.resolve([])
    ])
    console.log(`📊 Contexte: ${produits.length} produits, ${cmds.length} commandes`)

    const produitsCtx = buildProduitsContext(produits)
    const cmdsCtx     = cmds.length ? buildCmdContext(cmds) : ""

    // ── 2. System prompt ───────────────────────────────────────
    const systemPrompt = `
Tu es l'assistant vocal IA du store "${storeName || "notre boutique"}".
Tu aides les clients par téléphone ou chat. Tu parles en ${lang === "fr" ? "français" : lang === "ar" ? "arabe" : lang === "es" ? "espagnol" : "anglais"}.
Sois chaleureux, professionnel et concis.

=== CATALOGUE PRODUITS ===
${produitsCtx}

=== COMMANDES DU CLIENT ===
${cmdsCtx || "Aucune commande chargée. Si le client demande sa commande, invite-le à fournir son nom, email et date de commande."}

=== RÈGLES IMPORTANTES ===
1. Pour les PRODUITS : informe sur prix, description, disponibilité depuis le catalogue ci-dessus.
2. Pour les COMMANDES : demande d'abord nom + email + date de commande si pas fournis.
3. Si tu ne trouves PAS la réponse : réponds exactement cette phrase JSON :
   {"action":"SHOW_REQUEST_FORM","reason":"[raison précise]"}
4. Pour sauvegarder une requête : réponds exactement :
   {"action":"SAVE_REQUEST","data":{"nom":"...","email":"...","telephone":"...","question":"..."}}
5. Ne jamais inventer des prix ou informations produits absents du catalogue.
6. Email du store pour contact direct : ${storeEmail || "contact@store.com"}
7. Statuts commandes : en attente | payée | expédiée | livrée | annulée | retour | renseignements requis
`.trim()

    // ── 3. Construire les messages pour Groq ───────────────────
    const messages = [
      { role: "system",    content: systemPrompt },
      ...history.slice(-8), // Garder les 8 derniers échanges
      { role: "user",      content: message }
    ]

    // ── 4. Appel Groq ──────────────────────────────────────────
    const completion = await groq.chat.completions.create({
      model:       "llama-3.3-70b-versatile",
      messages,
      temperature: 0.4,
      max_tokens:  600,
    })

    const reply = completion.choices[0]?.message?.content?.trim() || ""

    // ── 5. Détecter les actions spéciales ─────────────────────
    let action      = null
    let actionData  = null
    let cleanReply  = reply

    // Détecter JSON action dans la réponse
    const jsonMatch = reply.match(/\{[\s\S]*"action"[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        action     = parsed.action
        actionData = parsed.data || { reason: parsed.reason }
        // Remplacer le JSON par un message naturel
        cleanReply = reply.replace(jsonMatch[0], "").trim()
        if (!cleanReply) {
          if (action === "SHOW_REQUEST_FORM") {
            const msgs = {
              fr: `Je ne trouve pas la réponse à votre question dans notre système. Permettez-moi de noter vos coordonnées pour qu'un conseiller vous rappelle.`,
              en: `I can't find the answer in our system. Let me take your details so an advisor can call you back.`,
              es: `No encuentro la respuesta en nuestro sistema. Déjame anotar sus datos para que un asesor le llame.`,
              ar: `لم أجد إجابة في نظامنا. دعني أسجّل بياناتك ليتصل بك أحد مستشارينا.`,
            }
            cleanReply = msgs[lang] || msgs.fr
          }
        }
      } catch(e) { /* pas un JSON valide, ignorer */ }
    }

    // ── 6. Réponse ─────────────────────────────────────────────
    res.json({
      reply:      cleanReply,
      action,
      actionData,
      model:      "llama-3.3-70b-versatile",
      productsFound: produits.length,
      ordersFound:   cmds.length,
    })

  } catch (e) {
    console.error("❌ Groq assistant error:", e.message)
    res.status(500).json({ error: "Erreur assistant IA", details: e.message })
  }
})


// ===============================================================
//  ENDPOINT : POST /api/save-request
//  Sauvegarder une requête non résolue dans Firestore
// ===============================================================
app.post("/api/save-request", async (req, res) => {
  const { storeUid, nom, email, telephone, adresse, question } = req.body

  if (!question) return res.status(400).json({ error: "question requise" })

  try {
    const id = await saveRequete(storeUid, { nom, email, telephone, adresse, question })
    res.json({ success: true, id, message: "Requête enregistrée avec succès" })
  } catch (e) {
    res.status(500).json({ error: "Erreur sauvegarde requête", details: e.message })
  }
})


// ===============================================================
//  ENDPOINT : GET /api/products/:storeUid
//  Retourner les produits d'un store (pour debug / frontend)
// ===============================================================
app.get("/api/products/:storeUid", async (req, res) => {
  const produits = await getProduits(req.params.storeUid)
  res.json({ produits, count: produits.length })
})


// ===============================================================
//  ENDPOINT : GET /api/orders/:storeUid
//  Retourner les commandes d'un store
// ===============================================================
app.get("/api/orders/:storeUid", async (req, res) => {
  const { email, nom, date } = req.query
  const cmds = await getCmdinfos(req.params.storeUid, { email, nom, date })
  res.json({ commandes: cmds, count: cmds.length })
})


// ===============================================================
//  WEBHOOK STRIPE (existant — conservé intact)
// ===============================================================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"]
    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (err) {
      console.error("❌ Webhook error:", err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object
      console.log("💰 PAYMENT SUCCESS:", session.id)

      if (session.payment_status === "paid") {
        try {
          const existing = await db.collection("orders").where("sessionId", "==", session.id).get()
          if (!existing.empty) { console.log("⚠️ Order déjà existante"); return res.json({ received: true }) }

          let metadata = {}
          try { metadata = session.metadata?.data ? JSON.parse(session.metadata.data) : {} } catch(e) {}

          const uid = metadata.clientId || "master"
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
          })
          await db.collection("sites").doc(uid).set({
            userId: uid,
            plan: metadata.plan || "premium",
            sections: [{ type: "hero", title: "Bienvenue" }, { type: "text", content: "Mon site SaaS" }],
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true })
          console.log("✅ ORDER + SITE OK:", session.id)
        } catch (err) { console.error("❌ Webhook processing error:", err) }
      }
    }
    res.json({ received: true })
  }
)


// ===============================================================
//  CREATE STRIPE SESSION (existant — conservé intact)
// ===============================================================
app.post("/create-stripe-session", async (req, res) => {
  try {
    let { items, email, adresseLivraison, clientId, plan, successUrl, cancelUrl } = req.body

    items = (items || []).map(item => ({
      nom:      item.nom      || item.title || "Produit",
      prix:     item.prix     || item.price || 0,
      quantity: item.quantity || item.qty   || 1,
    }))

    if (!items.length) return res.status(400).json({ error: "Panier vide" })

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: items.map(item => ({
        price_data: {
          currency: "eur",
          product_data: { name: item.nom },
          unit_amount: Math.round(item.prix * 100),
        },
        quantity: item.quantity,
      })),
      mode: "payment",
      success_url: successUrl || `${FRONTEND_URL}/`,
      cancel_url:  cancelUrl  || `${FRONTEND_URL}/`,
      metadata: {
        data: JSON.stringify({
          items,
          adresseLivraison: adresseLivraison || "",
          email:    email    || "",
          clientId: clientId || "master",
          plan:     plan     || "basic",
        }),
      },
    })

    console.log("🧾 Stripe session OK:", session.id)
    res.json({ url: session.url })

  } catch (err) {
    console.error("❌ Stripe session error:", err)
    res.status(500).json({ error: "Stripe session failed", details: err.message })
  }
})


// ===============================================================
//  HEALTH CHECK
// ===============================================================
app.get("/", (req, res) => {
  res.json({
    status:   "OK",
    service:  "SaaasGenerator Backend + Groq AI",
    groq:     !!process.env.VITE_GROQ_API_KEY ? "configuré" : "❌ clé manquante",
    firebase: serviceAccount ? "configuré" : "❌ non configuré",
    frontend: FRONTEND_URL,
    endpoints: [
      "POST /api/assistant",
      "POST /api/save-request",
      "GET  /api/products/:storeUid",
      "GET  /api/orders/:storeUid",
      "POST /create-stripe-session",
      "POST /webhook",
    ]
  })
})


// ===============================================================
//  START
// ===============================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`)
  console.log(`🤖 Groq AI: ${process.env.VITE_GROQ_API_KEY ? "✅ prêt" : "❌ clé manquante (VITE_GROQ_API_KEY)"}`)
  console.log(`🔥 Firebase: ${serviceAccount ? "✅ prêt" : "❌ non configuré"}`)
})

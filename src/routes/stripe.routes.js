const express = require("express");
const Stripe = require("stripe");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getBaseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

// Crée une session Stripe Checkout pour un abonnement mensuel
router.post("/create-checkout-session", async (req, res) => {
  try {
    const { cabinetId, email } = req.body;

    if (!cabinetId) {
      return res.status(400).json({ error: "cabinetId est obligatoire" });
    }

    if (!email) {
      return res.status(400).json({ error: "email est obligatoire" });
    }

    if (!process.env.STRIPE_PRICE_MONTHLY_ID) {
      return res
        .status(500)
        .json({ error: "STRIPE_PRICE_MONTHLY_ID manquant" });
    }

    const baseUrl = getBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_MONTHLY_ID,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/stripe/cancel`,
      metadata: {
        cabinetId,
        customerEmail: email,
      },
      subscription_data: {
        metadata: {
          cabinetId,
          customerEmail: email,
        },
      },
    });

    console.log("✅ Session Checkout créée", {
      cabinetId,
      email,
      sessionId: session.id,
      url: session.url,
    });

    return res.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("❌ Erreur création Checkout Session :", err.message);
    return res.status(500).json({
      error: "Impossible de créer la session Stripe",
    });
  }
});

// Webhook Stripe
router.post("/webhook", (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Erreur signature webhook Stripe :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        console.log("✅ Checkout terminé", {
          sessionId: session.id,
          customerId: session.customer,
          subscriptionId: session.subscription,
          cabinetId: session.metadata?.cabinetId || null,
          email: session.metadata?.customerEmail || session.customer_email || null,
        });

        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;

        console.log("✅ Paiement réussi", {
          invoiceId: invoice.id,
          customerId: invoice.customer,
          subscriptionId: invoice.subscription,
        });

        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;

        console.log("❌ Paiement échoué", {
          invoiceId: invoice.id,
          customerId: invoice.customer,
          subscriptionId: invoice.subscription,
        });

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        console.log("⛔ Abonnement supprimé", {
          subscriptionId: subscription.id,
          customerId: subscription.customer,
          cabinetId: subscription.metadata?.cabinetId || null,
        });

        break;
      }

      default:
        console.log(`ℹ️ Événement non géré : ${event.type}`);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Erreur traitement webhook Stripe :", err.message);
    return res.status(500).json({ error: "Erreur traitement webhook" });
  }
});

// Pages simples de retour pour test
router.get("/success", (req, res) => {
  res.send("Paiement Stripe réussi ✅");
});

router.get("/cancel", (req, res) => {
  res.send("Paiement Stripe annulé.");
});

module.exports = router;
const express = require("express");
const Stripe = require("stripe");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    console.error("Erreur signature webhook :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed":
      console.log("✅ Checkout terminé");
      break;

    case "invoice.paid":
      console.log("✅ Paiement réussi");
      break;

    case "invoice.payment_failed":
      console.log("❌ Paiement échoué");
      break;

    case "customer.subscription.deleted":
      console.log("⛔ Abonnement supprimé");
      break;

    default:
      console.log(`Événement non géré : ${event.type}`);
  }

  res.json({ received: true });
});

module.exports = router;
const express = require("express");
const Stripe = require("stripe");
const {
  upsertCabinet,
  findCabinetByCustomerId,
  findCabinetBySubscriptionId,
} = require("../services/cabinetsStore");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getBaseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

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

    upsertCabinet(cabinetId, {
      email,
      status: "pending_payment",
    });

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
        const cabinetId = session.metadata?.cabinetId;

        if (cabinetId) {
          const updated = upsertCabinet(cabinetId, {
            email: session.metadata?.customerEmail || session.customer_email || null,
            status: "active",
            stripeCustomerId: session.customer || null,
            stripeSubscriptionId: session.subscription || null,
            lastCheckoutSessionId: session.id,
          });

          console.log("✅ Cabinet activé après checkout", {
            cabinetId,
            cabinet: updated,
          });
        }

        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;

        const foundBySubscription = invoice.subscription
          ? findCabinetBySubscriptionId(invoice.subscription)
          : null;

        const foundByCustomer = !foundBySubscription && invoice.customer
          ? findCabinetByCustomerId(invoice.customer)
          : null;

        const found = foundBySubscription || foundByCustomer;

        if (found) {
          const updated = upsertCabinet(found.cabinetId, {
            status: "active",
            stripeCustomerId: invoice.customer || found.cabinet.stripeCustomerId || null,
            stripeSubscriptionId:
              invoice.subscription || found.cabinet.stripeSubscriptionId || null,
            lastPaidInvoiceId: invoice.id,
          });

          console.log("✅ Paiement réussi, cabinet confirmé actif", {
            cabinetId: found.cabinetId,
            cabinet: updated,
          });
        } else {
          console.log("ℹ️ Paiement reçu mais cabinet introuvable", {
            invoiceId: invoice.id,
            customerId: invoice.customer,
            subscriptionId: invoice.subscription,
          });
        }

        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;

        const foundBySubscription = invoice.subscription
          ? findCabinetBySubscriptionId(invoice.subscription)
          : null;

        const foundByCustomer = !foundBySubscription && invoice.customer
          ? findCabinetByCustomerId(invoice.customer)
          : null;

        const found = foundBySubscription || foundByCustomer;

        if (found) {
          const updated = upsertCabinet(found.cabinetId, {
            status: "inactive",
            lastFailedInvoiceId: invoice.id,
          });

          console.log("❌ Paiement échoué, cabinet désactivé", {
            cabinetId: found.cabinetId,
            cabinet: updated,
          });
        }

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        const found = findCabinetBySubscriptionId(subscription.id);

        if (found) {
          const updated = upsertCabinet(found.cabinetId, {
            status: "inactive",
          });

          console.log("⛔ Abonnement supprimé, cabinet désactivé", {
            cabinetId: found.cabinetId,
            cabinet: updated,
          });
        }

        break;
      }

            case "customer.subscription.updated": {
        const subscription = event.data.object;

        const found = findCabinetBySubscriptionId(subscription.id);

        if (found) {
          let nextStatus = found.cabinet.status;

          if (subscription.status === "active" || subscription.status === "trialing") {
            nextStatus = "active";
          } else if (
            subscription.status === "past_due" ||
            subscription.status === "unpaid" ||
            subscription.status === "canceled" ||
            subscription.status === "incomplete_expired"
          ) {
            nextStatus = "inactive";
          }

          const updated = upsertCabinet(found.cabinetId, {
            status: nextStatus,
            stripeSubscriptionStatus: subscription.status,
          });

          console.log("ℹ️ Abonnement mis à jour", {
            cabinetId: found.cabinetId,
            cabinet: updated,
            stripeStatus: subscription.status,
          });
        }

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

router.get("/success", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 40px;">
        <h1>Paiement Stripe réussi ✅</h1>
        <p>Votre abonnement a bien été pris en compte.</p>
        <p>Vous pouvez fermer cette page.</p>
      </body>
    </html>
  `);
});

router.get("/cancel", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 40px;">
        <h1>Paiement annulé</h1>
        <p>Votre abonnement n'a pas été finalisé.</p>
      </body>
    </html>
  `);
});

module.exports = router;
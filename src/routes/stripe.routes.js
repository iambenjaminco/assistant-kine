const express = require("express");
const Stripe = require("stripe");
const supabase = require("../config/supabase");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getBaseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

async function createPendingCabinet({ cabinetId, email }) {
  const payload = {
    id: cabinetId,
    email,
    status: "pending_payment",
    onboarding_completed: false,
    subscription_status: "pending",
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("cabinets")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateCabinetById(cabinetId, updates) {
  const { data, error } = await supabase
    .from("cabinets")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cabinetId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function findCabinetBySubscriptionId(stripeSubscriptionId) {
  const { data, error } = await supabase
    .from("cabinets")
    .select("*")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findCabinetByCustomerId(stripeCustomerId) {
  const { data, error } = await supabase
    .from("cabinets")
    .select("*")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function saveStripeEvent(event) {
  const { error } = await supabase.from("stripe_events").upsert(
    {
      stripe_event_id: event.id,
      type: event.type,
      payload_json: event,
      status: "processed",
      processed_at: new Date().toISOString(),
    },
    { onConflict: "stripe_event_id" }
  );

  if (error) {
    throw error;
  }
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

    await createPendingCabinet({ cabinetId, email });

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
      client_reference_id: cabinetId,
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

async function handleWebhook(req, res) {
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
        const cabinetId =
          session.metadata?.cabinetId || session.client_reference_id;

        if (cabinetId) {
          const updated = await updateCabinetById(cabinetId, {
            email:
              session.metadata?.customerEmail ||
              session.customer_email ||
              null,
            status: "pending_setup",
            stripe_customer_id: session.customer || null,
            stripe_subscription_id: session.subscription || null,
            stripe_subscription_status: "active",
            subscription_status: "active",
            last_checkout_session_id: session.id,
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

        const found =
          (invoice.subscription &&
            await findCabinetBySubscriptionId(invoice.subscription)) ||
          (!invoice.subscription && invoice.customer
            ? await findCabinetByCustomerId(invoice.customer)
            : null);

        if (found) {
          const updated = await updateCabinetById(found.id, {
            status: found.onboarding_completed ? "active" : "pending_setup",
            stripe_customer_id:
              invoice.customer || found.stripe_customer_id || null,
            stripe_subscription_id:
              invoice.subscription || found.stripe_subscription_id || null,
            stripe_subscription_status: "active",
            subscription_status: "active",
            last_paid_invoice_id: invoice.id,
          });

          console.log("✅ Paiement réussi, cabinet confirmé actif", {
            cabinetId: found.id,
            cabinet: updated,
          });
        }

        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;

        const found =
          (invoice.subscription &&
            await findCabinetBySubscriptionId(invoice.subscription)) ||
          (!invoice.subscription && invoice.customer
            ? await findCabinetByCustomerId(invoice.customer)
            : null);

        if (found) {
          const updated = await updateCabinetById(found.id, {
            status: "inactive",
            stripe_subscription_status: "past_due",
            subscription_status: "past_due",
            last_failed_invoice_id: invoice.id,
          });

          console.log("❌ Paiement échoué, cabinet désactivé", {
            cabinetId: found.id,
            cabinet: updated,
          });
        }

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        const found = await findCabinetBySubscriptionId(subscription.id);

        if (found) {
          const updated = await updateCabinetById(found.id, {
            status: "canceled",
            stripe_subscription_status: "canceled",
            subscription_status: "canceled",
          });

          console.log("⛔ Abonnement supprimé, cabinet désactivé", {
            cabinetId: found.id,
            cabinet: updated,
          });
        }

        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;

        const found = await findCabinetBySubscriptionId(subscription.id);

        if (found) {
          let nextStatus = found.status;

          if (
            subscription.status === "active" ||
            subscription.status === "trialing"
          ) {
            nextStatus = found.onboarding_completed ? "active" : "pending_setup";
          } else if (
            subscription.status === "past_due" ||
            subscription.status === "unpaid" ||
            subscription.status === "canceled" ||
            subscription.status === "incomplete_expired"
          ) {
            nextStatus = "inactive";
          }

          const updated = await updateCabinetById(found.id, {
            status: nextStatus,
            stripe_subscription_status: subscription.status,
            subscription_status: subscription.status,
          });

          console.log("ℹ️ Abonnement mis à jour", {
            cabinetId: found.id,
            cabinet: updated,
            stripeStatus: subscription.status,
          });
        }

        break;
      }

      default:
        console.log(`ℹ️ Événement non géré : ${event.type}`);
    }

    await saveStripeEvent(event);

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Erreur traitement webhook Stripe :", err.message);
    return res.status(500).json({ error: "Erreur traitement webhook" });
  }
}

router.get("/success", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Abonnement activé</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px; max-width: 720px; margin: auto; line-height: 1.6; color: #111;">
        <h1>Abonnement activé ✅</h1>
        <p>Votre paiement a bien été confirmé.</p>
        <p>La prochaine étape consiste à finaliser la configuration de votre assistant téléphonique.</p>
        <p>Vous pouvez maintenant poursuivre l'onboarding.</p>
      </body>
    </html>
  `);
});

router.get("/cancel", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Paiement annulé</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px; max-width: 720px; margin: auto; line-height: 1.6; color: #111;">
        <h1>Paiement annulé</h1>
        <p>Votre abonnement n'a pas été finalisé.</p>
        <p>Vous pourrez reprendre le paiement lorsque vous le souhaitez.</p>
      </body>
    </html>
  `);
});

module.exports = router;
module.exports.handleWebhook = handleWebhook;
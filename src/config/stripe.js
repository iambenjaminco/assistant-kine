// src/config/stripe.js
const Stripe = require("stripe");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY manquante");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = stripe;
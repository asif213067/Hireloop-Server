import Stripe from "stripe";
import { env } from "../env.js";

// Stripe instance for server-side verification and webhook signature checks
export const stripe = env.stripeSecretKey
  ? new Stripe(env.stripeSecretKey)
  : null;

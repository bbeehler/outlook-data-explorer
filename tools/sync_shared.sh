#!/bin/sh
# Copy the shared Stripe helper into each function that uses it (each Supabase function deploys as one folder).
cd "$(dirname "$0")/../supabase/functions" && for f in hub-checkout hub-stripe-webhook hub-account; do cp _shared/stripe.ts "$f/stripe.ts"; done

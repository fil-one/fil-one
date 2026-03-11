# Stripe Integration & Billing Considerations

## Open Questions

1. **Wallet implementation** — Self-hosted hot wallet on EKS, or custodial service (Fireblocks, BitGo, Anchorage)? Custodial adds cost but provides signing policies, insurance, and audit trails.
2. **FIL acquisition pipeline** — How do we convert USD (from Stripe payouts) to FIL? Automated via exchange API, manual/OTC, or fiat-to-crypto onramp?
3. **Can any onramps accept USD?** — Would eliminate the FIL conversion step entirely for those providers. Might be useful for a prototype if acceptable to onramp. Potentially can bill offline as well for P0 through invoicing/contracts.
4. **Data retention post-cancellation** — When a customer cancels, do we delete MEKs immediately (data unrecoverable) or retain for a grace period? - I suggest grace period (maybe smart contract duration?) since it's nominal cost to us at first.
5. **Stripe Tax** — Do we have tax obligations worldwide as a storage orchestration layer? Likely yes in some jurisdictions (EU VAT, certain US states). Stripe Tax can automate but requires registration. Where do we register? Delaware/US? More complex?
6. **Pricing model** — The $5/TB rate matches onramp cost, leaving negative margin after infra, tx fees, and Stripe fees. See [Appendix D: Economics & Pricing Alternatives](#appendix-d-economics--pricing-alternatives). We can ignore if we are fine with this.
7. **Multi-currency** — Charge everyone in USD, or support local currencies? Local currency improves international conversion rates but adds complexity.
8. **Invoice detail level** — What customer-facing information on invoices? (Usage breakdown, object count, peak vs. average, etc.)
9. **Dunning policy** — How many payment retries before suspension? Grace period before cancellation/reactivation?
10. **Deletion billing policy** — When a customer deletes an object, we stop billing but the Filecoin deal (and our cost) continues until expiration. See [Appendix E: Deletion & Filecoin Immutability](#appendix-e-deletion--filecoin-immutability).
11. **Retrieval billing** — Do we charge for data retrievals? Every download requires a key exchange through our API, giving us a natural metering point. See [Appendix F: Retrieval Billing Considerations](#appendix-f-retrieval-billing-considerations).

---

## Constraints

- Customers pay in **USD via Stripe**; we pay onramp providers in **FIL** from a managed wallet (USD payment to onramps is an open question)
- Flat rate: **$5/TB/month** for storage
- **Free trial:** 14 days, 1 TB limit
- Customer types: individual developers, commercial, and enterprise (focus on first two initially)
- **Metered billing** — charge based on actual storage (maybe retrievals?) used per billing period
- We store **metadata on-chain** (wrapped DEK references, object manifests) alongside customer data — this has its own FIL cost that we absorb
- We absorb **FIL transaction fees** when paying onramps
- **Worldwide customers** — fraud surface is broad
- No KYC requirement — we are a storage orchestration layer, not a financial service
- Fraud prevention is required (Stripe Radar)
- Infrastructure: EKS, RDS Postgres, AWS Secrets Manager (?)

---

## Stripe Products

### Use

| Product                    | Purpose                                                                 | Priority                                   |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| **Stripe Billing**         | Subscriptions with metered usage reporting                              | Day 1 — core billing engine                |
| **Stripe Checkout**        | Hosted payment page for signup / payment method collection              | Day 1 — fastest path to collecting payment |
| **Stripe Customer Portal** | Self-service billing management (update card, view invoices, cancel)    | Day 1 — reduces support burden             |
| **Stripe Radar**           | Fraud prevention (stolen cards, suspicious activity)                    | Day 1 — worldwide customers                |
| **Stripe Webhooks**        | React to billing events (payment success/failure, subscription changes) | Day 1 — required for billing lifecycle     |
| **Stripe Tax**             | Automatic sales tax / VAT for worldwide customers                       | Evaluate early                             |
| **Stripe Invoicing**       | PDF invoices, net-30/60 terms, purchase orders                          | Enterprise phase                           |
| **Stripe Connect**         | Multi-party payments (revenue-share with onramp providers)              | Not needed now                             |

### Do Not Need

| Product             | Why Not                                            |
| ------------------- | -------------------------------------------------- |
| **Stripe Identity** | No KYC requirement. Revisit if regulations change. |
| **Stripe Issuing**  | Not issuing cards                                  |
| **Stripe Terminal** | No physical point-of-sale                          |

---

## Billing Model Options

### Option 1: Metered Usage (Recommended)

Report actual storage consumption to Stripe each billing cycle. Stripe calculates the invoice.

```
1. Customer subscribes (payment method collected via Checkout)
2. Stripe creates Subscription with metered Price ($5/unit, 1 unit = 1 TB)
3. Our backend takes daily storage snapshots per customer
4. At billing period end (triggered by invoice.creating webhook),
   we report average TB to Stripe
5. Stripe generates invoice and charges payment method
```

**UX:** Customer pays only for what they use. No commitment, no tier selection. Feels like AWS/GCP billing.

**Tradeoffs:**

- Customer-friendly — low barrier, pay-as-you-go
- Unpredictable revenue for us — hard to forecast
- Requires robust usage tracking infrastructure (daily snapshots, averaging)
- Small users may generate very small invoices ($0.50 for 100GB) — Stripe minimum charge considerations

**Stripe API choice:** Evaluate the **Meters API** (newer, event-based, better audit trail) over the legacy **Usage Records API**. Meters support `sum`, `max`, and `count` aggregations and store individual events.

**Storage aggregation:** Use **average storage over the billing period** (daily snapshots, averaged). This is the industry standard (AWS S3 uses this approach) and is fairer than peak-based billing.

### Option 2: Tiered Block Pricing

Sell storage in fixed blocks. Customer pays for the block whether or not they fill it.

| Tier    | Storage | Price  | Effective $/TB |
| ------- | ------- | ------ | -------------- |
| Starter | 1 TB    | $7/mo  | $7.00          |
| Growth  | 5 TB    | $30/mo | $6.00          |
| Scale   | 10 TB   | $50/mo | $5.00          |

**UX:** Customer picks a plan at signup. Upgrade/downgrade via Stripe Customer Portal.

**Tradeoffs:**

- Predictable revenue — customers pre-pay for capacity
- Higher friction at signup (must choose a tier)
- Customers who don't fill their block feel they're overpaying (churn risk)
- Need overage handling — what happens when a customer exceeds their tier? Auto-upgrade, block uploads, or metered overage?
- Simpler billing infrastructure — no usage snapshots needed, just enforce limits

**Stripe implementation:** Fixed-price Subscription tiers. Upgrade/downgrade via Subscription update with proration.

### Option 3: Metered with Platform Fee

Separate "platform access" from "storage consumption."

- **Platform fee:** $10-25/month fixed (covers key management, API access, metadata storage, encryption infra)
- **Storage:** $5/TB/month metered (pass-through to onramp cost)

**UX:** Two line items on the invoice. Customer sees platform value separated from raw storage.

**Tradeoffs:**

- Creates a margin floor from the platform fee regardless of storage usage
- Two line items may confuse customers ("why am I paying twice?")
- Platform fee deters tire-kickers — only committed users subscribe
- Better aligns pricing with value delivered (encryption, key management, S3 compatibility are the product, not raw storage)

**Stripe implementation:** Subscription with two Price objects — one fixed recurring, one metered.

### Option 4: Metered with Minimum Commitment

Charge $5/TB metered, but enforce a monthly minimum (e.g., $10/month).

**UX:** Feels like metered, but small/inactive users still pay a floor.

**Tradeoffs:**

- Guarantees minimum revenue per customer
- Simple to explain ("$5/TB, $10 minimum")
- May deter very small or experimental users
- Need to handle the case where usage charge < minimum (top-up line item on invoice)

**Stripe implementation:** Metered price + conditional invoice item adjustment if usage is below minimum.

### Recommendation

Start with **Option 1 (pure metered)** for launch to minimize signup friction and match developer expectations. The usage tracking infrastructure built for Option 1 supports all other options — the only change is the Stripe Price configuration. Revisit pricing model based on actual usage patterns and margin data after 90 days.

---

## Free Trial

### Structure

- **Duration:** 14 days
- **Storage limit:** 1 TB
- **Stripe native:** `trial_period_days: 14` on the Subscription — Stripe handles the trial window automatically

### Payment Method at Signup: Tradeoff

| Approach                                 | Pros                                                                                        | Cons                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Require card at signup** (Recommended) | Seamless conversion to paid, Radar scores card immediately, reduces freeloaders/trial abuse | Higher signup friction, lower top-of-funnel conversion                                                                                           |
| **No card until trial ends**             | Lower friction, more signups                                                                | Must prompt for card at trial end (drop-off point), trial abuse risk (new accounts for perpetual free storage), Radar can't assess until payment |

**Recommendation:** Require payment method at signup via Stripe Checkout in `setup` mode. This collects and validates the card without charging. Radar scores it immediately, blocking stolen/fraudulent cards before they consume real Filecoin storage (which costs us real FIL).

### Trial Abuse Prevention

Free trials consume real Filecoin storage at our cost, so abuse is a direct financial loss:

- **Radar:** Score payment method at signup, block high-risk cards
- **Rate limiting:** One trial per payment method, one trial per email domain
- **Usage enforcement:** Backend rejects uploads exceeding the 1TB trial limit
- **Disposable email blocking:** Via Radar custom rules

### Trial-to-Paid Conversion Flow

```
Day 0:  Signup -> Checkout (setup mode) -> Radar scores card -> Subscription created with trial
Day 1-14: Customer uses storage, tracked in our DB, 1TB limit enforced
Day 11: Stripe fires trial_will_end webhook -> we notify customer
Day 14: Trial ends -> Stripe begins billing cycle
Day 44: First invoice generated (for usage during days 14-44) -> charged automatically
```

---

## Radar Integration

### What It Does

Stripe Radar uses ML to score every payment for fraud risk: card fingerprint, issuing bank, IP address, device fingerprint, velocity checks, and cross-network fraud signals.

### Where It Applies

1. **At signup** — Radar scores the SetupIntent when collecting the card. High-risk cards are blocked before any resources are provisioned.
2. **At each billing cycle** — Radar scores each automatic charge. No additional integration needed.
3. **Custom rules** (Radar for Fraud Teams add-on) — configurable rules for our specific risk profile.

### Recommended Rules

| Rule                                | Rationale                                           |
| ----------------------------------- | --------------------------------------------------- |
| Block if card country != IP country | Reduces stolen card usage (may need VPN exceptions) |
| Require 3D Secure for first charge  | Shifts fraud liability to card issuer               |
| Block disposable email providers    | Prevents trial abuse                                |
| Review queue if risk score > 65     | Manual review for borderline cases                  |

### Radar Is Not KYC

Radar prevents fraudulent payments. It does not verify identity. If identity verification becomes a regulatory requirement, **Stripe Identity** can be added later. For now, Radar + card validation + email verification is a reasonable baseline for a storage orchestration service.

---

## Customer Lifecycle

```
1. SIGNUP
   |-- Create Stripe Customer
   |-- Stripe Checkout (setup mode) -> collect + validate payment method
   |-- Radar scores card
   |-- Create Subscription (trial_period_days: 14, metered price)

2. TRIAL (14 days, 1 TB limit)
   |-- Usage tracked in our DB, enforced at upload time
   |-- No charges
   |-- Day 11: trial_will_end webhook -> notify customer

3. CONVERSION
   |-- Trial ends, billing cycle begins
   |-- First invoice at end of first billing period
   |-- We report metered usage to Stripe on invoice.creating webhook
   |-- Stripe charges card on file

4. ONGOING
   |-- Monthly cycle: daily snapshots, usage reported, auto-charged
   |-- Customer self-serves via Stripe Customer Portal

5. PAYMENT FAILURE
   |-- Stripe Smart Retries (automatic)
   |-- We send dunning emails on invoice.payment_failed
   |-- After N failures: suspend account (read-only? no new uploads?)
   |-- Eventually: cancel subscription, begin data retention policy

6. CANCELLATION
   |-- Stop accepting new uploads
   |-- Data remains on Filecoin until deals expire (encrypted, keys deleted)
   |-- Open question: MEK deletion timing and grace period
```

---

## Webhook Events to Handle

| Event                                  | Action                                      |
| -------------------------------------- | ------------------------------------------- |
| `customer.subscription.created`        | Record subscription, start usage tracking   |
| `customer.subscription.trial_will_end` | Notify customer (3 days before)             |
| `customer.subscription.updated`        | Handle plan changes, payment method updates |
| `customer.subscription.deleted`        | Stop tracking, begin data retention policy  |
| `invoice.creating`                     | **Report metered usage to Stripe**          |
| `invoice.payment_succeeded`            | Record payment, update status               |
| `invoice.payment_failed`               | Dunning flow                                |
| `charge.dispute.created`               | Flag account, potentially suspend           |
| `radar.early_fraud_warning`            | Flag account for review                     |

Webhook security: verify signatures, idempotency layer (webhooks can be delivered multiple times), async processing via DB queue or SQS.

---

## Enterprise Considerations (Future)

| Need                              | Stripe Product                          | Notes                          |
| --------------------------------- | --------------------------------------- | ------------------------------ |
| Net-30/60 payment terms           | Stripe Invoicing                        | PDF invoices, ACH/wire support |
| Custom pricing / volume discounts | Custom Stripe Prices                    | Per-customer Price objects     |
| Annual contracts                  | Stripe Billing (subscription schedules) | Committed minimums with phases |
| Purchase orders                   | Stripe Invoicing metadata               | PO numbers on invoices         |
| SLA credits                       | Credit notes via Stripe API             | Manual adjustments             |

---

## Managed Wallet & Onramp Payment Flow

```
Customer (USD via Stripe)
    |
    v
Stripe Account --> Bank Account --> FIL Purchase (exchange/OTC) --> Managed FIL Wallet
    |
    v
Onramp Provider (pays in FIL per deal)
    |
    v
Filecoin SPs (data stored)
```

**Open questions:** Wallet infra (self-hosted vs. custodial), FIL acquisition method, FIL price volatility management, whether any onramps accept USD directly. See Open Questions at top.

---

## Appendix A: Metered Usage Tracking Schema

Our Postgres DB is the source of truth for usage. We report summarized usage to Stripe but never rely on Stripe as the sole usage record.

### Usage Events to Capture

| Event                    | Data                                                                                   | When                                         |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| Object uploaded          | `customer_id`, `object_id`, `encrypted_size_bytes`, `metadata_size_bytes`, `timestamp` | On upload confirmation (onramp confirms CID) |
| Object deleted (logical) | `customer_id`, `object_id`, `deletion_timestamp`                                       | Customer requests deletion                   |
| Deal expiration          | `customer_id`, `object_id`, `deal_expiry_timestamp`                                    | Filecoin deal expires (poll onramp or chain) |
| Metadata stored on-chain | `customer_id`, `chain_storage_bytes`, `tx_hash`, `fil_cost`                            | On-chain write confirmed                     |

### Tables

```sql
-- Daily storage snapshots for billing aggregation
CREATE TABLE storage_usage_snapshots (
    id                      BIGSERIAL PRIMARY KEY,
    customer_id             UUID NOT NULL REFERENCES customers(id),
    snapshot_time           TIMESTAMPTZ NOT NULL DEFAULT now(),
    active_bytes            BIGINT NOT NULL,
    active_object_count     INT NOT NULL,
    metadata_chain_bytes    BIGINT NOT NULL,
    billable_tb             NUMERIC(12,6) GENERATED ALWAYS AS (
                                active_bytes::NUMERIC / (1024.0^4)
                            ) STORED,
    estimated_fil_cost      NUMERIC(18,8),
    estimated_metadata_cost NUMERIC(18,8),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-object lifecycle tracking
CREATE TABLE storage_objects (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id             UUID NOT NULL REFERENCES customers(id),
    bucket_id               UUID NOT NULL REFERENCES buckets(id),
    object_key              TEXT NOT NULL,
    encrypted_size_bytes    BIGINT NOT NULL,
    metadata_size_bytes     INT NOT NULL,
    uploaded_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ,
    deal_expires_at         TIMESTAMPTZ,
    cid                     TEXT,
    deal_id                 TEXT,
    onramp_ref              TEXT,
    wrapped_dek_id          UUID REFERENCES wrapped_deks(id),
    UNIQUE(customer_id, bucket_id, object_key)
);

CREATE INDEX idx_storage_objects_customer_active
    ON storage_objects(customer_id) WHERE deleted_at IS NULL;

-- Free trial tracking
CREATE TABLE customer_trials (
    customer_id             UUID PRIMARY KEY REFERENCES customers(id),
    trial_start             TIMESTAMPTZ NOT NULL DEFAULT now(),
    trial_end               TIMESTAMPTZ NOT NULL,
    storage_limit_bytes     BIGINT NOT NULL DEFAULT 1099511627776, -- 1 TB
    storage_used_bytes      BIGINT NOT NULL DEFAULT 0,
    converted_at            TIMESTAMPTZ,
    stripe_subscription_id  TEXT,
    status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'converted', 'expired', 'cancelled'))
);
```

### Usage Reporting Flow

```
Daily cron (EKS):
  For each active customer:
    1. SUM(encrypted_size_bytes) WHERE deleted_at IS NULL
    2. Add metadata_chain_bytes
    3. Insert into storage_usage_snapshots

On invoice.creating webhook:
  For each customer on the invoice:
    1. Query snapshots for billing period
    2. Calculate average billable_tb
    3. Report to Stripe (Meters API or Usage Records API)
    4. Stripe generates line item: avg_tb * $5.00
```

---

## Appendix B: Onramp Cost Tracking Schema

```sql
CREATE TABLE onramp_payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers(id),
    object_id           UUID REFERENCES storage_objects(id),
    onramp_provider     TEXT NOT NULL,
    deal_id             TEXT,
    fil_amount          NUMERIC(18,8) NOT NULL,
    fil_tx_fee          NUMERIC(18,8) NOT NULL,
    fil_usd_rate        NUMERIC(12,6),
    total_usd_cost      NUMERIC(12,6),
    customer_charge_usd NUMERIC(12,6),
    metadata_fil_cost   NUMERIC(18,8),
    metadata_tx_fee     NUMERIC(18,8),
    wallet_address      TEXT NOT NULL,
    tx_hash             TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirmed', 'failed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at        TIMESTAMPTZ
);
```

---

## Appendix C: Backend Services

| Service             | Responsibility                                               | Runs On                              |
| ------------------- | ------------------------------------------------------------ | ------------------------------------ |
| **Billing Service** | Stripe API calls, webhook processing, usage reporting        | EKS pod                              |
| **Usage Tracker**   | Daily storage snapshots, aggregation, free trial enforcement | EKS cron job                         |
| **Wallet Service**  | FIL wallet management, onramp payments, cost tracking        | EKS pod (or separate secure service) |
| **Dunning Worker**  | Payment failure notifications, account suspension logic      | EKS cron/worker                      |

### DB Tables Summary

| Table                     | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `customers`               | Core customer record, linked to Stripe Customer ID |
| `customer_trials`         | Free trial tracking                                |
| `stripe_subscriptions`    | Local mirror of Stripe subscription state          |
| `storage_objects`         | Per-object tracking (size, lifecycle, CID, deal)   |
| `storage_usage_snapshots` | Daily snapshots for billing aggregation            |
| `onramp_payments`         | FIL payments to onramps (cost tracking)            |
| `stripe_webhook_events`   | Idempotency log for webhook processing             |
| `invoices`                | Local mirror of Stripe invoices                    |

---

## Appendix D: Economics & Pricing Alternatives

### Current Margin Problem

At $5/TB (matching onramp cost), margin is negative after:

- AWS infrastructure (EKS, RDS, Secrets Manager, networking)
- On-chain metadata storage (wrapped DEK references, object manifests, CIDs)
- FIL transaction fees to onramps
- Stripe processing fees (~2.9% + $0.30 per charge)
- Key management overhead
- FIL price volatility on the cost side

This is viable as a growth/adoption play. The billing system should support pricing changes without a rewrite.

### Alternatives

**Tiered block pricing** — Sell blocks (1TB/$7, 5TB/$30, 10TB/$50). Predictable revenue, customers may over-provision. See Option 2 in Billing Model Options.

**Platform fee + metered storage** — $10-25/mo platform fee + $5/TB metered. Separates platform value from raw storage cost. See Option 3.

**Metered with minimum** — $5/TB with $10/mo floor. Guarantees minimum revenue per customer. See Option 4.

**Markup** — Charge $7-8/TB instead of $5. Simplest margin fix but changes the messaging.

The usage tracking infrastructure (daily snapshots, per-object tracking) is the same regardless of model — only the Stripe Price configuration and invoice logic changes.

### Metadata Storage Costs

On-chain metadata is infrastructure overhead. Track per-customer in `metadata_chain_bytes` and `metadata_fil_cost` for margin analysis. Do not bill separately at this stage. If adopting a platform fee model, metadata costs are covered by that fee.

---

## Appendix E: Deletion & Filecoin Immutability

When a customer deletes an object:

1. We mark it deleted in our DB
2. We delete/disable the wrapped DEK (data becomes cryptographically inaccessible)
3. The encrypted ciphertext **remains on Filecoin** until the deal expires
4. We continue paying the onramp for that deal until expiration

**Options:**

| Approach                               | Customer UX                                  | Our cost                     |
| -------------------------------------- | -------------------------------------------- | ---------------------------- |
| Stop billing at deletion (Recommended) | Matches expectations                         | We absorb residual deal cost |
| Bill until deal expires                | Confusing — "I deleted it, why am I paying?" | Cost-neutral but churn risk  |

**Recommendation:** Stop billing at logical deletion. Absorb residual cost. Disclose in ToS that data remains encrypted on-chain until deal expiration but is cryptographically inaccessible. Track the cost gap in `onramp_payments`.

---

## Appendix F: Retrieval Billing Considerations

Every download requires the client to call our Console API for the plaintext DEK before fetching the encrypted blob from the onramp. This key exchange is a natural metering point — we know exactly which object, its size, and the requesting customer.

### Why Consider Billing for Retrievals

- **Margin improvement** — Retrieval fees are pure margin since the client fetches data directly from the onramp (no egress cost to us). The only cost we incur is the DEK unwrap compute and API serving, which is negligible.
- **Industry precedent** — AWS S3, GCP Cloud Storage, and Azure Blob all charge for GET requests and/or egress. Users expect some retrieval cost.
- **Abuse prevention** — Without retrieval costs, a customer storing 1TB could generate unlimited download traffic. While the bandwidth doesn't flow through us, excessive key exchange requests load our API.
- **Aligns with Filecoin economics** — Filecoin itself distinguishes storage deals from retrieval deals. Some onramps may charge us for retrieval separately.
- **On-chain retrieval costs are unknown** — PoRep (Filecoin's proof-of-replication protocol) handles on-chain storage deal payments, but not all onramps use PoRep or expose retrieval costs the same way. Some onramps may bundle retrieval into the storage deal, others may charge separately, and the payment mechanism (on-chain vs. off-chain) varies by provider. Until we know the retrieval cost structure per onramp, we can't determine whether retrieval is a pass-through cost or pure margin.

### Why NOT Bill for Retrievals (At Launch)

- **Simplicity** — "$5/TB/month, unlimited downloads" is a cleaner pitch than "$5/TB storage + $X per retrieval"
- **Competitive positioning** — Many Filecoin/IPFS storage services offer free retrieval. Adding retrieval fees may push users to competitors.
- **Low cost to us** — Key exchange is a lightweight API call. Until we hit scale, the compute cost is negligible.
- **Developer experience** — Developers dislike unpredictable costs from retrieval patterns they can't easily forecast.

### Billing Models If We Do Charge

| Model                         | How It Works                                                      | UX Impact                                            |
| ----------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| **Per-request**               | Charge per download request (e.g., $0.005 per 1,000 GET requests) | Predictable per-call, penalizes frequent small reads |
| **Per-GB retrieved**          | Charge based on bytes of objects retrieved (e.g., $0.01/GB)       | Scales with data size, feels like egress pricing     |
| **Tiered free allowance**     | Free retrievals up to N x stored data per month, then per-GB      | Generous for normal use, catches abuse               |
| **Included in storage price** | No separate charge, baked into $5/TB                              | Simplest, but no abuse protection                    |

### What to Track Regardless of Billing Decision

Track retrieval events in the DB even if we don't bill for them. This data informs future pricing decisions and helps identify abuse.

| Field                             | Purpose                  |
| --------------------------------- | ------------------------ |
| `customer_id`                     | Who requested            |
| `object_id`                       | What was retrieved       |
| `object_size_bytes`               | Size of retrieved object |
| `timestamp`                       | When                     |
| `source_ip`                       | Abuse detection          |
| `request_count` (daily aggregate) | Volume patterns          |

### Recommendation

Launch with **free unlimited retrievals** ("$5/TB, unlimited downloads") for competitive positioning. Track all retrieval events in the DB from day one. Revisit after 90 days with actual usage data — if retrieval volume is disproportionate to storage or causing API load issues, introduce a tiered free allowance model.

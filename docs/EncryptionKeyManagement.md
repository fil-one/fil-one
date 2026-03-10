# Encryption & Key Management

## Problem Statement

We need (at minimum) per-customer/bucket encryption for data stored via Filecoin SPs through the onramp API. The primary constraint is **data transmission** — we cannot afford to proxy all uploads/downloads through our AWS infrastructure. Encryption must happen without bulk data flowing through AWS.

### Questions/constraints informing this

1. Are onramps willing to integrate with a hosted key management service? If so, recommendation might change.
2. S3 has a 50TB limit. PoRep has 32GB limit. What is the largest expected file size for first 90 days? Long term we want to support the former limits, I think.
3. What encryption algorithm do we use? See **Encryption Algorithm Choices** section below.
4. Does the download path also go direct from onramp → client (bypassing our infra)? If not, downloads become the real bandwidth bottleneck, not uploads.
5. How do we handle key backup/recovery? If a MEK is lost, all customer data encrypted with it is unrecoverable.
6. Do we need to support customer-managed keys (BYOK) in the future? If so, envelope encryption supports this — customer provides their own MEK.

## Recommendation

**Client-side encryption with envelope encryption** with a path towards chunked files since S3 can have very large files stored which cannot be encrypted in one go on client side.

Our infra handles keys, the onramp only sees encrypted text, and clients perform encryption. We can open source the client side encryption as a library to hide the potential complexity with very large files that might not fit in client memory. This is likely to occur longer term and we want a consistent implementation for the community to use.

---

## Option A: Client-Side Encryption with Envelope Encryption (Recommended)

### Upload Flow

```
1. Client authenticates → requests upload session from Console API
2. Console API generates a per-object Data Encryption Key (DEK), wraps it with the customer's
   Master Key (MEK), persists wrapped DEK in DB (tied to object metadata), returns:
   - plaintext DEK (short-lived, in-memory only)
3. Client encrypts data in-browser using Web Crypto API (AES-256-GCM)
4. Client uploads encrypted blob directly to onramp API (or through our shim layer)
5. Console API never sees the file data — only key material (~256 bytes)
```

### Download Flow

```
1. Client requests download (object ID) from Console API
2. Console API looks up wrapped DEK in DB, unwraps with MEK, returns plaintext DEK
3. Client fetches encrypted blob directly from onramp (or through Shim layer)
4. Client decrypts locally - need to implement in SDKs as well.
```

### Pros

- Data never transits our AWS infra — only key exchange does (good for low egress)
- "Scales" "naturally": encryption compute is distributed across all clients
- We retain control via MEKs (can revoke access, rotate keys, support key-per-bucket or even file)
- Onramp(s) only ever sees encrypted text

### Cons

- Web Crypto API has no streaming support for AES-GCM — entire plaintext must fit in memory for encrypt. For large files (>1-2GB), chunked encryption is needed (see Option C)
- Client JS becomes security-critical — a bug in encryption = data loss or exposure
- Non-browser clients (CLI tools, SDKs) must reimplement the same crypto
- Cannot do any server-side processing on the data (search, thumbnails, virus scanning) without decrypting somewhere

---

## Option B: Onramp-Side Encryption via Key Service

### How It Works

```
1. Client authenticates → Console API generates a presigned/tokenized upload URL
2. Client uploads plaintext directly to onramp API (no AWS transit)
3. Onramp calls a key service (hosted by us) to fetch the DEK
4. Onramp encrypts before storing to SP
```

### Pros

- Simplest client implementation — no crypto in the browser
- Data still bypasses AWS (client → onramp directly)
- Supports server-side operations before encryption (validation, scanning)
- Easier to support multiple client types (web, CLI, SDK)

### Cons

- Plaintext exists briefly at the onramp — if onramp is compromised, data is exposed
- Onramp needs network access to our key service — couples the OSS layer back to our infra
- When others self-host the OSS layer, they need their own key management
- More trust placed in the onramp layer

---

## Option C: Hybrid Chunked Client-Side Encryption (Future — Large File Support)

### How It Works

Same as Option A, but designed for large files:

```
1. Client splits file into fixed-size chunks (e.g., 64MB)
2. Each chunk encrypted separately with the same DEK but unique IV/nonce
3. Chunks uploaded in parallel directly to onramp
4. Manifest (chunk order + IVs + wrapped DEK) stored as metadata
```

### Pros

- Solves the memory problem — never holds full file in memory
- Parallel chunk upload = faster for large files
- Resumable uploads (re-upload only failed chunks)
- Same trust/security properties as Option A

### Cons

- Significantly more complex client logic
- Onramp needs to understand the chunking/manifest format (or abstract it behind the S3-compatible API)
- Chunk reassembly on download adds latency

---

## Key Management Design

### Key Hierarchy

| Key                       | Scope               | Storage                                              | Purpose              |
| ------------------------- | ------------------- | ---------------------------------------------------- | -------------------- |
| Master Key (MEK)          | Per customer/bucket | AWS Secrets Manager or encrypted DB table            | Wraps DEKs           |
| Data Encryption Key (DEK) | Per object          | Stored wrapped (encrypted) alongside object metadata | Encrypts actual data |

### Key Lifecycle

- **MEK Creation**: Generated when a customer/bucket is created
- **DEK Generation**: Generated per upload, never persisted in plaintext — only the wrapped version is stored
- **Key Rotation**: Re-wrap all DEKs with a new MEK (no re-encryption of data needed). See [Appendix A](#appendix-a-key-rotation-with-filecoin-immutable-storage) for how this works with Filecoin's immutable storage.
- **Access Revocation**: Delete/disable MEK — all wrapped DEKs become undecryptable

## Encryption Algorithm Choices

Data stored via Filecoin SPs is publicly accessible ciphertext with potentially decades-long retention. This means the algorithm must withstand **harvest-now-decrypt-later** attacks where an adversary stores ciphertext today and breaks it with a future quantum computer. Additionally, encryption runs in a **browser web worker**, which constrains us to Web Crypto API natives or WASM-compiled libraries.

### Quantum safety note

For **symmetric** encryption, 256-bit key lengths are already considered quantum-safe. Grover's algorithm reduces effective security by half (256-bit → 128-bit equivalent), which remains well beyond brute-force feasibility. The real quantum threat is to **asymmetric** crypto (RSA, ECC) used in key exchange — that concern applies to how we protect MEK transport, not the data encryption algorithm itself. All options below with 256-bit keys are quantum-safe for the symmetric layer.

Blog: https://www.ssh.com/academy/quantum-safe-cryptography-algorithms-vs-quantum-resistant-algorithms-whats-difference

---

### Option 1: AES-256-GCM (Recommended for MVP)

Native to the Web Crypto API. Authenticated encryption (confidentiality + integrity in one pass).

| Aspect          | Detail                                                  |
| --------------- | ------------------------------------------------------- |
| Key size        | 256-bit (quantum-safe)                                  |
| Nonce           | 96-bit (12 bytes)                                       |
| Auth tag        | 128-bit                                                 |
| Browser support | Native Web Crypto API — works in all modern web workers |

**Pros**

- Zero external dependencies — native `crypto.subtle.encrypt("AES-GCM", ...)` in web workers
- Hardware-accelerated via AES-NI on most devices — fast even for large chunks
- Well-studied, NIST-approved, widely deployed (TLS 1.3, AWS S3 SSE, Google Tink)
- Single-pass authenticated encryption simplifies implementation

**Cons**

- **96-bit nonce is small** — with random nonces, collision probability becomes dangerous after ~2^32 encryptions under the same key. With per-object DEKs this is mitigated (each DEK encrypts one object), but with chunked encryption (Option C) nonces must be sequential/counter-based per DEK, not random
- **~64 GB per-key plaintext limit** before GCM's authentication guarantees degrade. Again mitigated by per-object DEKs, but large chunked files under one DEK need monitoring
- **No streaming support** in Web Crypto — entire plaintext must be in memory for a single `encrypt()` call. Chunked encryption (Option C) works around this at the application layer
- **Catastrophic on nonce reuse** — reusing a nonce under the same key leaks the XOR of two plaintexts and the auth key. Implementation must guarantee unique nonces

---

### Option 2: XChaCha20-Poly1305

A stream cipher + MAC construction. Not native to Web Crypto but available via **libsodium.js** (WASM-compiled, runs in web workers).

| Aspect          | Detail                              |
| --------------- | ----------------------------------- |
| Key size        | 256-bit (quantum-safe)              |
| Nonce           | 192-bit (24 bytes)                  |
| Auth tag        | 128-bit                             |
| Browser support | Requires libsodium.js (~200KB WASM) |

**Pros**

- **192-bit nonce eliminates collision risk** — safe to generate nonces randomly for every chunk without coordination, even at massive scale (~2^96 encryptions before concern)
- Constant-time by design — no timing side-channels regardless of hardware (AES without AES-NI can be vulnerable to cache-timing attacks)
- Simpler to use safely — the large nonce space makes misuse much harder
- libsodium.js is battle-tested and audited; WASM runs well in web workers

**Cons**

- **Not in Web Crypto API** — requires bundling libsodium.js (~200KB WASM), adding a dependency to the security-critical web worker
- No hardware acceleration — purely software, ~2-3x slower than AES-256-GCM on devices with AES-NI (most modern x86/ARM). For chunk sizes of 64MB this may add noticeable latency
- Less common in enterprise compliance contexts — some regulated environments specifically require AES (FIPS 140-2/3)
- WASM loading adds startup latency in the web worker

---

### Option 3: AES-256-CTR + HMAC-SHA-256 (Encrypt-then-MAC)

Separates encryption (AES-CTR) from authentication (HMAC). Both primitives are native to Web Crypto API.

| Aspect          | Detail                                                                    |
| --------------- | ------------------------------------------------------------------------- |
| Key size        | 256-bit encryption + 256-bit HMAC (two keys or derived from one via HKDF) |
| Nonce/IV        | 128-bit for CTR mode                                                      |
| Auth tag        | 256-bit HMAC                                                              |
| Browser support | Native Web Crypto API (both AES-CTR and HMAC)                             |

**Pros**

- **Both primitives are native Web Crypto** — no external dependencies
- AES-CTR supports streaming/chunked encryption natively in Web Crypto (`encrypt` with a counter) — no need to buffer full plaintext
- **No per-key plaintext limit** — CTR mode doesn't degrade like GCM at high volumes
- Encrypt-then-MAC is the most conservative authenticated encryption pattern — well understood and provably secure
- 128-bit IV is larger than GCM's 96-bit nonce — more room for random generation

**Cons**

- **Two-pass construction** — must encrypt, then compute HMAC over the ciphertext. Slower than single-pass GCM for the same data
- More implementation surface area — getting Encrypt-then-MAC wrong (e.g., MAC-then-Encrypt, or not including the IV in the HMAC) introduces vulnerabilities
- Requires deriving two separate keys (encryption + MAC) from the DEK, adding HKDF or similar key derivation
- Less "standard" as a combined construction — harder for third-party auditors to validate vs. a single AEAD call
- CTR mode without authentication is malleable — if the HMAC check is skipped or bypassed, ciphertext can be modified undetected

---

### Option 4: AES-256-GCM-SIV (Nonce-Misuse Resistant)

A variant of AES-GCM that remains secure even if a nonce is accidentally reused. Not native to Web Crypto.

| Aspect          | Detail                                        |
| --------------- | --------------------------------------------- |
| Key size        | 256-bit (quantum-safe)                        |
| Nonce           | 96-bit (12 bytes)                             |
| Auth tag        | 128-bit                                       |
| Browser support | Requires JS/WASM library (e.g., miscreant.js) |

**Pros**

- **Nonce-misuse resistant** — if a nonce is reused, only reveals whether two plaintexts are identical; does not leak plaintext XOR or auth key (unlike GCM)
- Same key/nonce sizes as GCM — conceptually a drop-in replacement
- Designed by Google, used in Google Tink and Android keystore

**Cons**

- **Not in Web Crypto API** — requires a JS/WASM library, same dependency concern as XChaCha20
- Less mature browser library ecosystem compared to libsodium
- ~2x slower than GCM (two AES passes per block)
- Smaller community and fewer audits than GCM or ChaCha alternatives

---

### Algorithm Recommendation

**AES-256-GCM for MVP** with a plan to evaluate **XChaCha20-Poly1305** for the chunked encryption path (Option C).

Rationale:

- AES-256-GCM is native Web Crypto, zero dependencies, hardware-accelerated, and quantum-safe at 256-bit keys
- Per-object DEKs mitigate GCM's nonce-collision and plaintext-limit risks since each key encrypts one object (or a bounded number of chunks)
- For chunked large files, use **sequential counter-based nonces** (not random) per DEK to eliminate collision risk
- When we build the chunked encryption library (Option C), evaluate XChaCha20-Poly1305 for its safer random nonce generation — this matters more when a single DEK encrypts many chunks and we want to parallelize chunk encryption across workers without nonce coordination
- If FIPS compliance becomes a requirement, AES-256-GCM is the clear choice since ChaCha20 is not FIPS-approved

---

## Security considerations

1. For extra security, we should do this within a page that has no external JS Dependencies to mitigate issues in external libraries stealing plaintext encrypted key. For instance, do this in a web-worker compiled separate from the rest of the Webapp.

---

## Appendix A: Key Rotation with Filecoin Immutable Storage

Filecoin storage is immutable — once data is sealed into a deal, it cannot be modified in place. This has direct implications for key rotation under Option A (client-side envelope encryption).

### MEK Rotation (cheap, no Filecoin rewrite)

MEK rotation does **not** require re-encrypting data or creating new Filecoin deals, because the MEK never touches the data directly. It only wraps DEKs, and wrapped DEKs live in **our database**, not on Filecoin.

```
1. Generate new MEK (v2)
2. For each wrapped DEK in the database:
   a. Unwrap DEK using old MEK (v1)
   b. Re-wrap DEK using new MEK (v2)
   c. Store updated wrapped DEK, tagged with MEK version
3. After all DEKs are migrated, disable/archive old MEK (v1)
```

**Key design requirement**: Wrapped DEKs must be stored in our metadata DB, not on Filecoin alongside the ciphertext. The Filecoin blob should contain only the encrypted data (and optionally a reference ID to look up the wrapped DEK).

**Migration window considerations**:

- During migration, some DEKs are wrapped with v1 and some with v2 — each wrapped DEK record must be tagged with its MEK version so the Console API knows which MEK to use for unwrapping
- Both MEK versions must remain available until migration completes
- Cost scales with **number of objects** (one re-wrap per DEK), not data volume — a million objects is a million ~256-byte re-wrap operations, which is fast

### DEK Rotation (expensive, requires Filecoin rewrite)

DEK rotation requires **re-encrypting the actual data**, which means:

```
1. Download encrypted blob from Filecoin/onramp
2. Decrypt with old DEK
3. Generate new DEK, re-encrypt data
4. Upload new ciphertext to onramp → new Filecoin deal
5. Store new wrapped DEK in DB
6. Old Filecoin deal eventually expires (data remains sealed until deal ends)
```

This is expensive: new storage deal costs, sealing time, and the old ciphertext remains on Filecoin until the deal expires. DEK rotation should only be triggered if a specific DEK is compromised, not as routine maintenance.

### Practical Guidance

| Scenario                             | Action                                    | Filecoin impact                                                                           |
| ------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Routine rotation (policy/compliance) | Rotate MEK only                           | None — DB-only operation                                                                  |
| MEK compromised                      | Rotate MEK                                | None — re-wrap all DEKs in DB                                                             |
| Specific DEK compromised             | Rotate that DEK                           | Rewrite that object — new Filecoin deal (does this actually help??)                       |
| Customer offboarding / data deletion | Delete MEK                                | None — all wrapped DEKs become unusable. Ciphertext remains on Filecoin but is unreadable |
| Add MEK per file                     | Create N MEKs where N is user's file-data | High — New Filecoin deal **per object**                                                   |

---

## Appendix B: Envelope Encryption Key & Data Flow Diagram

```
┌─────────────────────┐        ┌─────────────────────────┐        ┌──────────────────────┐
│       CLIENT        │        │   CONSOLE API (AWS)     │        │  ONRAMP → FILECOIN   │
│(Browser-Worker/SDK) │        │                         │        │                      │
└─────────┬───────────┘        └────────────┬────────────┘        └──────────┬───────────┘
          │                                 │                                │
          │  ── UPLOAD ───────────────────────────────────────────────────   │
          │                                 │                                │
          │  1. Auth + request upload       │                                │
          │ ─────────────────────────────►  │                                │
          │                                 │                                │
          │                          ┌──────┴──────┐                         │
          │                          │ Generate DEK │                        │
          │                          │ Wrap DEK with│                        │
          │                          │ MEK from DB  │                        │
          │                          │              │                        │
          │                          │ Save wrapped │                        │
          │                          │ DEK in DB    │                        │
          │                          │ (tied to     │                        │
          │                          │  object ID)  │                        │
          │                          └──────┬──────┘                         │
          │                                 │                                │
          │  2. plaintext DEK               │                                │
          │ ◄─────────────────────────────  │                                │
          │    (~256 bytes, NO file data)   │                                │
          │                                 │                                │
   ┌──────┴──────┐                          │                                │
   │ Encrypt file │                         │                                │
   │ with DEK     │                         │                                │
   │ (AES-256-GCM)│                         │                                │
   │ Discard DEK  │                         │                                │
   └──────┬──────┘                          │                                │
          │                                 │                                │
          │  3. Encrypted blob (bulk, direct to onramp)                      │
          │ ─────────────────────────────────────────────────────────────►   │
          │                                 │                                │
          │                                 │                         ┌──────┴──────┐
          │                                 │                         │ Store to SP  │
          │                                 │                         │ (ciphertext) │
          │                                 │                         │              │
          │                                 │                         │ Generate CID │
          │                                 │                         │ (hash of     │
          │                                 │                         │  encrypted   │
          │                                 │                         │  content)    │
          │                                 │                         └──────┬──────┘
          │                                 │                                │
          │  4. CID returned to client (TODO Determine if this works)        │
          │ ◄─────────────────────────────────────────────────────────────   │
          │                                 │                                │
          │  5. Confirm upload + CID (TODO) │                                │
          │ ─────────────────────────────►  │                                │
          │                                 │                                │
          │                          ┌──────┴──────┐                         │
          │                          │ Save CID in  │                        │
          │                          │ DB tied to   │                        │
          │                          │ object ID +  │                        │
          │                          │ wrapped DEK  │                        │
          │                          └─────────────┘                         │
          │                                 │                                │
          │  ── DOWNLOAD ─────────────────────────────────────────────────   │
          │                                 │                                │
          │  1. Request download (object ID)│                                │
          │ ─────────────────────────────►  │                                │
          │                                 │                                │
          │                          ┌──────┴──────┐                         │
          │                          │ Look up CID  │                        │
          │                          │ + wrapped DEK│                        │
          │                          │ Unwrap DEK   │                        │
          │                          │ with MEK     │                        │
          │                          └──────┬──────┘                         │
          │                                 │                                │
          │  2. plaintext DEK + CID         │                                │
          │ ◄─────────────────────────────  │                                │
          │                                 │                                │
          │  3. Fetch encrypted blob by CID (bulk, direct)                   │
          │ ─────────────────────────────────────────────────────────────►   │
          │                                 │                                │
          │  4. Encrypted blob                                               │
          │ ◄─────────────────────────────────────────────────────────────   │
          │                                 │                                │
   ┌──────┴──────┐                          │                                │
   │ Decrypt file │                         │                                │
   │ with DEK     │                         │                                │
   │ Discard DEK  │                         │                                │
   └─────────────┘                          │                                │


  STORAGE SUMMARY
  ───────────────────────────────────────────────────────────────────────

  Console API DB (per object record):
  ┌─────────────────────────────────────────────────┐
  │  object_id  │  wrapped_dek  │  cid  │  mek_ver  │
  └─────────────────────────────────────────────────┘

  MEK (Master Encryption Key)
    Where: Console API only (AWS Secrets Manager / encrypted DB)
    Never leaves AWS. Used server-side to wrap/unwrap DEKs.

  DEK (Data Encryption Key) — plaintext
    Where: Client memory only (ephemeral)
    Created by Console API, sent to client, used to encrypt/decrypt,
    then immediately discarded. Never persisted in plaintext.

  Wrapped DEK (DEK encrypted by MEK)
    Where: Console API DB (keyed by object ID)
    NOT on Filecoin — enables MEK rotation without rewriting data
    (see Appendix A).

  CID (Content Identifier)
    Where: Console API DB (keyed by object ID)
    Hash of the encrypted blob, generated by onramp/Filecoin network.
    Used to retrieve data from the Filecoin network on download.
    The CID is of the ciphertext, not the plaintext — so it reveals
    nothing about the original data.

  Encrypted blob (ciphertext)
    Where: Filecoin (via onramp → SP)
    Addressable by CID. Publicly visible but unreadable without DEK.

  WHAT FLOWS WHERE
  ───────────────────────────────────────────────────────────────────────
  Client  ↔  Console API  :  Keys + CID only (small payloads)
  Client  ↔  Onramp       :  Encrypted data + CID (bulk transfer)
  Console API never sees file data. Onramp never sees plaintext.
```

---

## Appendix C: S3-Compatible Encryption vs. Low-Egress Architecture

### The Tension

This document recommends **client-side envelope encryption** where bulk data flows directly from the client to the onramp, bypassing our cloud infrastructure entirely. Only key material (~256 bytes per request) touches our AWS backend. This is critical for keeping egress costs low and the architecture scalable.

However, the S3-compatible endpoint design (see S3Considerations.md) introduces a competing pressure: **transparent server-side encryption (SSE)** is the seamless path for S3 users. In that model, the user sends plaintext to our S3-compatible endpoint, our server encrypts it, and writes ciphertext to Filecoin. This means **all data flows through our infrastructure** — exactly what we're trying to avoid.

### The Tradeoff Matrix

|                        | Client-Side Encryption (this doc, Option A)                                | S3 Server-Side Encryption (SSE)                                        |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Data path**          | Client → Onramp directly (bulk); Client ↔ Console API (keys only)          | Client → Our S3 endpoint → Onramp (all data proxied)                   |
| **Egress cost**        | Minimal — only key material through AWS                                    | **High** — every byte uploaded/downloaded passes through our infra     |
| **User experience**    | Requires encryption-aware client (our SDK/library or S3 Encryption Client) | Fully transparent — standard `aws s3 cp` just works                    |
| **Encryption control** | Client performs crypto; we manage keys                                     | Server performs crypto; fully managed                                  |
| **Onramp trust model** | Onramp only sees ciphertext                                                | Onramp only sees ciphertext (same)                                     |
| **Scalability**        | Encryption compute is distributed across all clients                       | Encryption compute is centralized on our servers — scales with traffic |
| **Compliance**         | Plaintext never leaves the client device                                   | Plaintext exists briefly on our servers (in memory during encryption)  |

### Options to Reconcile

#### Option 1: Client-Side Only (No S3 SSE Support)

Keep the architecture as designed in this document. Users who need S3 compatibility use our SDK/library which handles encryption locally, then uploads ciphertext via the S3-compatible endpoint. The S3 endpoint receives pre-encrypted data and passes it through.

```
Client (encrypts locally using our library)
    │
    ├─ GET key from Console API (~256 bytes)
    │
    ├─ Encrypt locally
    │
    └─ PUT ciphertext via S3 endpoint ──► Onramp ──► Filecoin
       (no decryption/re-encryption on server)
```

**Pros**: Low egress, matches current design, server never sees plaintext.
**Cons**: Not fully transparent S3 — users must use our encryption library or the AWS S3 Encryption Client configured with our KMS. Plain `aws s3 cp` sends plaintext, which our endpoint would need to reject or handle.

#### Option 2: S3 SSE for Small Objects, Client-Side for Large (Hybrid)

Offer transparent SSE for objects below a size threshold (e.g., <100MB) where egress cost is manageable, and require client-side encryption for larger objects.

```
Small objects (<100MB):
  Client ─── plaintext ──► S3 endpoint (encrypts) ──► Onramp ──► Filecoin

Large objects (>100MB):
  Client (encrypts locally) ──► S3 endpoint (pass-through) ──► Onramp ──► Filecoin
```

**Pros**: Good UX for the common case (most S3 objects are small); large files don't blow up egress.
**Cons**: Two code paths. Users must understand when to use which mode. Multipart upload boundary becomes an awkward switching point.

#### Option 3: S3 Endpoint as a Thin Redirect Layer (Recommended)

The S3-compatible endpoint handles authentication, authorization, and key distribution — but **redirects the actual data transfer** to the onramp. This keeps the S3 UX for control operations while keeping bulk data off our infra.

```
PutObject flow:
  1. Client sends PUT to S3 endpoint
  2. S3 endpoint authenticates (SigV4), generates DEK, wraps with MEK
  3. S3 endpoint returns a 307 redirect (or presigned onramp URL)
     with the plaintext DEK in a secure response header or short-lived token
  4. Client's SDK/library encrypts locally with DEK
  5. Client uploads ciphertext directly to onramp URL
  6. S3 endpoint confirms and stores metadata

GetObject flow:
  1. Client sends GET to S3 endpoint
  2. S3 endpoint authenticates, looks up wrapped DEK, unwraps
  3. S3 endpoint returns redirect to onramp + DEK token
  4. Client fetches ciphertext from onramp
  5. Client's SDK/library decrypts locally
```

**Pros**: S3 endpoint stays lightweight (no bulk data); low egress; encryption keys managed centrally; data path is direct client-to-onramp.
**Cons**: Standard `aws s3 cp` won't handle the encrypt-after-redirect flow natively — this requires **our thin SDK wrapper or CLI** that understands the redirect + encrypt pattern. The AWS SDK handles 307 redirects, but not "redirect + encrypt before uploading." This is the main limitation.

#### Option 4: Transparent S3 SSE with Edge Nodes (Future)

Deploy S3-compatible encryption at the edge (CDN/edge compute nodes close to users) so that encryption happens near the client without routing through a central AWS region. Edge nodes handle SigV4 auth, envelope encryption, and forward ciphertext to onramps.

**Pros**: Fully transparent S3 UX; egress stays within edge networks (cheaper than cross-region); encryption compute distributed across edge.
**Cons**: Operational complexity of managing encryption keys at edge nodes; higher infrastructure cost; trust boundary extends to edge.

### Recommendation

**Option 1 (client-side only) for MVP, with Option 3 (redirect layer) as the target architecture.**

Rationale:

- The low-egress constraint is a hard business requirement — we cannot afford to proxy bulk data through AWS, especially at scale
- For MVP, users will use our SDK/library which handles encryption transparently on their machine; the S3 endpoint accepts ciphertext and routes to the onramp
- Option 3 provides the best long-term balance: the S3 endpoint remains the control plane (auth, keys, metadata) while bulk data flows directly to onramps
- This does mean plain `aws s3 cp` without our wrapper won't get transparent encryption — but this is the same tradeoff every provider with client-side encryption makes (including AWS itself with the S3 Encryption Client)
- The key insight is that **S3 API compatibility and client-side encryption are not mutually exclusive** — the S3 Encryption Client already exists as the AWS-blessed pattern for this. We just need to provide a compatible keyring/CMM that talks to our KMS instead of AWS KMS

### Compatibility with AWS S3 Encryption Client

The AWS S3 Encryption Client supports [custom keyrings](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/concepts.html) — you can implement a keyring that calls your KMS instead of AWS KMS. This means:

1. User configures the S3 Encryption Client with your custom keyring
2. On PutObject: client generates DEK, calls your KMS to wrap it, encrypts locally, uploads ciphertext via your S3 endpoint
3. On GetObject: client downloads ciphertext from your S3 endpoint, calls your KMS to unwrap DEK, decrypts locally
4. Bulk data goes through the S3 endpoint but it's **already ciphertext** — your server is just proxying encrypted bytes, not doing encryption
5. Your egress carries ciphertext, not plaintext — same bytes regardless, but encryption compute is on the client

```
AWS S3 Encryption Client + Your Custom Keyring
    │
    ├─ Generates DEK
    ├─ Calls your KMS to wrap DEK (small request)
    ├─ Encrypts locally (client CPU)
    │
    └─ PutObject (ciphertext) via S3 endpoint ──► Onramp ──► Filecoin
       (server only sees ciphertext, same egress as direct-to-onramp)
```

This is the most standards-compliant path: users get S3 SDK compatibility, client-side encryption, and your endpoint stays low-compute. The tradeoff is that ciphertext still flows through your endpoint (egress cost for bytes), but no encryption/decryption compute and no plaintext exposure.

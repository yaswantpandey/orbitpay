# OrbitPay ⚡

A modern, full-stack digital wallet and payment platform by **Ecotech Services**, built with **Next.js 16**, **TypeScript**, **Tailwind CSS v4**, and **Firebase** (Auth, Firestore, Cloud Functions). OrbitPay supports P2P transfers, multi-currency balances, merchant checkouts, recurring payments, bill splitting, savings goals, fraud detection, and multi-tier KYC verification.

---

## 🚀 Features

### 💳 Core Wallet & Payments
- **Atomic Double-Entry Ledger**: Every transfer, deposit, conversion, and withdrawal is settled atomically via Cloud Firestore transactions and recorded in an immutable ledger.
- **P2P Money Transfers**: Instantly send and receive money via email address or QR code.
- **Top-up & Withdrawals**: Fund wallet balances via Stripe payments and withdraw funds with payout hold/release mechanics.
- **Money Requests**: Request payments from contacts with automatic expiration tracking.
- **Bill Splitting**: Split group expenses easily among multiple recipients.
- **Recurring Payments**: Schedule automated daily, weekly, or monthly payments.
- **Invoicing**: Generate professional invoices with payment links and email dispatch.

### 🌐 Multi-Currency & FX
- **Multi-Currency Holding**: Hold separate balances across multiple currencies.
- **Real-Time FX Conversion**: Instant currency conversion with live exchange rates, configurable spread, and stale-rate safeguards.

### 🎯 Savings Pots
- **Dedicated Savings Goals**: Lock funds into isolated goals/pots (`/savings`).
- **Atomic Allocation**: Transfer money to and from savings goals without mixing with everyday spending balances.

### 🛒 Merchant Platform & Checkout API
- **Merchant Profiles**: Enable merchant mode with business name and webhook endpoints.
- **API Key Management**: Create and revoke hashed API keys (SHA-256) for programmatic integrations.
- **Hosted Checkout**: Dedicated `/checkout` payment page for external transactions.
- **Signed Webhooks**: HMAC-SHA256 signed event deliveries with exponential backoff retries.

### 🛡️ Security, Risk & Compliance
- **Two-Factor Authentication (2FA)**: Time-based One-Time Password (TOTP) verification.
- **Multi-Tier KYC**: Stripe Identity integration (document & selfie check) with admin review options.
- **Automated Fraud & Risk Engine**:
  - Velocity limits (rate-limiting rapid transactions)
  - New account transaction caps
  - Large payment holds for unverified recipients
  - Automated account freezing and administrative review queue
- **Granular Firestore Security Rules**: Robust security rules enforcing document isolation and role-based permissions.

### 📬 Notifications
- **In-App Notification Feed**: Instant alerts for payments, requests, and security updates.
- **Transactional Emails**: Email delivery powered by Resend (with local outbox logging for development).

---

## 🛠️ Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router, Turbopack, React 19)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Backend / Database**: [Firebase Cloud Firestore](https://firebase.google.com/docs/firestore), [Firebase Authentication](https://firebase.google.com/docs/auth)
- **Serverless Compute**: [Cloud Functions for Firebase (v2)](https://firebase.google.com/docs/functions)
- **Payments & KYC**: [Stripe](https://stripe.com/) & Stripe Identity
- **Validation**: [Zod](https://zod.dev/) & [React Hook Form](https://react-hook-form.com/)
- **Testing**: [Vitest](https://vitest.dev/) & Firebase Local Emulator Suite

---

## 📂 Project Structure

```text
├── src/
│   ├── app/                 # Next.js App Router pages
│   │   ├── add-money/       # Stripe top-up page
│   │   ├── admin/           # Administrative review queue & controls
│   │   ├── checkout/        # Hosted merchant checkout page
│   │   ├── contacts/        # Saved contacts & recipients
│   │   ├── currencies/      # Multi-currency balances & FX exchange
│   │   ├── dashboard/       # Main user wallet overview
│   │   ├── history/         # Transaction & ledger history
│   │   ├── insights/        # Spending statistics and analytics
│   │   ├── invoices/        # Invoice generator and status
│   │   ├── login/           # Authentication portal
│   │   ├── merchant/        # Merchant dashboard & API keys
│   │   ├── pay/             # Quick pay & QR code scanner
│   │   ├── recurring/       # Scheduled transfer manager
│   │   ├── requests/        # Inbound and outbound money requests
│   │   ├── savings/         # Savings goals and pots
│   │   ├── send/            # P2P payment transfer flow
│   │   ├── settings/        # Profile, notification, & KYC settings
│   │   ├── setup-2fa/       # Two-factor authentication enrollment
│   │   ├── split/           # Group bill splitting
│   │   └── withdraw/        # Payout and withdrawal flow
│   ├── components/          # Reusable UI components
│   ├── lib/                 # Client utilities, Firebase SDK, and schemas
│   └── types/               # TypeScript interfaces and domain models
├── functions/               # Cloud Functions backend
│   └── src/                 # Ledger engine, FX, KYC, merchant, risk & tests
├── firestore.rules          # Firestore security rules
├── firestore.indexes.json   # Firestore compound indexes
└── firebase.json            # Firebase configuration & emulator ports
```

---

## ⚙️ Getting Started

### Prerequisites
- **Node.js**: `v20.9.0` or higher (Node 24 supported)
- **npm**: `v10` or higher
- **Firebase CLI**: `npm install -g firebase-tools`
- **Java**: Required to run the Firebase Local Emulator Suite

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/yaswantpandey/orbitpay.git
cd orbitpay
npm install
npm --prefix functions install
```

### 2. Environment Variables
Create a `.env.local` file in the root directory:
```env
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

For Cloud Functions, configure `functions/.env` or secrets:
```env
STRIPE_SECRET_KEY=sk_test_...
RESEND_API_KEY=re_...
```

### 3. Running with Firebase Emulators (Recommended for Dev)
Start the Firebase Local Emulator Suite along with Cloud Functions:
```bash
npm run emulators
```

In a separate terminal, launch the Next.js development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🧪 Testing & Verification

- **Ledger Invariant & Backend Tests**:
  ```bash
  npm run test:ledger
  ```
- **Linting**:
  ```bash
  npm run lint
  ```
- **Production Build**:
  ```bash
  npm run build
  ```

---

## 📄 License
Proprietary — Ecotech Services. All rights reserved.
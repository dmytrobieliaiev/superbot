# Organization context

This file is injected verbatim into the system prompt every turn. Edit it to
teach the bot durable facts about your organization. Restart the bot (or just
let the cache expire — currently cached for process lifetime) to apply.

Use markdown headings. Keep it under ~2000 words to leave room for memory + tools.

---

## Who we are

Spendbase — fintech platform for SaaS spend management and corporate banking.
Launched early 2023. Mission: help companies optimize software costs and usage.
Core value drivers: visibility and control. ~200 people. Delaware-incorporated
with engineering roots in Ukraine. PCI DSS certified (achieved in 9 months,
first-time pass).

CEO: **Andrew Alex** (LinkedIn: alexseyenko).

Customer onboarding targets ~30% SaaS cost reduction within 30 days.

## Products

- **spendbase.co** — SaaS spend management + corporate banking. SaaS expense
  tracking, license usage monitoring, renewal management, vendor negotiation,
  procurement workflow automation. Corporate banking with EU/UK IBAN accounts,
  SEPA / Faster Payments, virtual cards (up to 100) with spend controls, 3DS,
  up to 1.5% cashback.
- **llmapi.ai** — LLM API product.
- **chargebase.co** — billing / charging product.
- **mailerr** — email product.

<!-- TODO fill: tighter one-liner for llmapi / chargebase / mailerr scope -->

## Team structure

<!-- TODO fill:
- Engineering leads:
- Product:
- Standup channel:
- Incidents channel:
-->

## Internal jargon

<!-- TODO fill org-specific terms (e.g. internal codenames, abbreviations) -->

## Key links

<!-- TODO fill:
- Engineering handbook:
- Status page:
- Runbook:
- Main repo(s):
-->

## House rules for the bot

- Default response language: English
- Code: Go (Golang) for backend, TypeScript for frontend unless user specifies otherwise
- Repo naming: backend projects suffixed `-api` or `-backend`, frontend projects suffixed `-app`
- Currency: USD (primary), EUR secondary
- Timezone reference: Europe/Kyiv
- Treat customer financial data as sensitive — never echo card numbers, full
  PANs, or full bank account numbers in logs or responses

# AI Logistics Control Tower

Event-driven agentic automation of the shipment lifecycle — intake through
proof of delivery — built as the system of record for live operations with real
carrier spend.

**Stack:** Python 3.11+ · Postgres 17 · NVIDIA NIM (Nemotron 3) · Next.js (later)

---

## The rule everything follows from

**Deterministic code detects. The model only reasons.**

ETA drift, SLA breach, geofence exit and dwell time are arithmetic over a
tracking event. They run on every event, cost nothing, and are unit-testable.
A model wakes only when that arithmetic fires an exception.

At 5,000 shipments/day a 15-minute poll is over a million checks. Putting a
model on those instead of on the ~370 exceptions is the difference between a
system that scales and one that dies in pilot — on cost, latency and
determinism alike.

The same rule applies in miniature inside `order.validate`: deterministic
checks run first, and if they find a blocking gap no model is called at all.

---

## Quick start

```bash
docker compose up -d                         # Postgres on :5433
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"

cp .env.example .env                         # add your NVIDIA_API_KEY
.venv/Scripts/python.exe -m logistics.cli migrate
.venv/Scripts/python.exe -m logistics.cli seed-demo

.venv/Scripts/python.exe -m logistics.cli submit examples/LG-82931.json
.venv/Scripts/python.exe -m logistics.cli worker      # Ctrl-C to stop
.venv/Scripts/python.exe -m logistics.cli status LG-82931
```

Commands: `migrate`, `seed-demo`, `worker`, `submit`, `status`, `queue`,
`check-llm`.

---

## How a shipment moves

```
DRAFT ──order.validate──> VALIDATED ──warehouse.allocate──> ALLOCATED
      └─> NEEDS_INFO                └─> EXCEPTION                │
                                                        planning.plan
                                                                │
   CLOSED <── POD_VERIFIED <── DELIVERED <── IN_TRANSIT <── BOOKED
                                                                │
                                              AWAITING_APPROVAL │
                                                                │
                                            SOURCING <──carrier.source
```

The orchestrator is a **durable Postgres state machine**, not an LLM planner.
The lifecycle is identical for every shipment, so there is nothing to plan per
shipment — and a state machine is replayable, testable, and cannot invent a
transition that does not exist.

`STATE_ROUTES` in `src/logistics/orchestrator/routing.py` is the entire "what
happens next" decision. States absent from it are genuine waits, advanced by
the outside world: a customer reply, a carrier quote, a human approval, a
tracking event.

**Handlers never write to `shipments`, `shipment_events` or `work_items`.**
They return a `StepResult`, and the orchestrator applies the transition,
events, legs and follow-up work in one transaction. A crash leaves a shipment
either fully advanced or untouched — never half-way.

---

## Multimodal

A shipment is an ordered sequence of **legs**, each with its own mode, carrier,
conveyance and state. Lagos → Tema is truck → vessel → truck; cargo does not
teleport to the port.

```
PLANNED → SOURCING → BOOKED → AT_ORIGIN → IN_TRANSIT
        → AT_DESTINATION → HANDED_OFF → COMPLETED
```

`HANDED_OFF` is deliberately distinct from `COMPLETED`. A container discharged
at Apapa with nobody booked to collect it is the classic way a multi-leg
shipment dies quietly — `stuck_at_handoff()` makes that queryable.

---

## Tracking and detection

Nothing in `src/logistics/tracking/` imports the model layer — [a test enforces
that](tests/test_tracking.py), because a comment would not.

```bash
python -m logistics.cli simulate --scenario delayed    # clean | delayed | off-route
python -m logistics.cli sweep                          # absence detection, once
python -m logistics.cli worker                         # applies the state change
```

**On-event rules** fire from something that happened — ETA drift, SLA breach
risk, route deviation, dwell, temperature excursion. They run on every ping.

**Absence rules** fire from something that did *not* happen — a checkpoint
never reached, a vehicle that stopped reporting. These cannot be event-driven:
silence produces no event to react to. `detection.sweep` catches them and
reschedules itself every 15 minutes. Missing this distinction is how a truck
goes quiet and nobody notices.

Two properties keep the economics honest:

- **One open exception per kind per shipment**, enforced by a partial unique
  index. A 15-minute poll on one delayed truck would otherwise raise ~96 rows a
  day and later burn a model call on each.
- **`LOW` severity records but does not escalate.** Only `MEDIUM` and above
  enqueue work.

Route deviation is measured against the straight line between origin and
destination, so its corridor is deliberately wide (90 km). Roads do not follow
great circles — Ibadan sits ~46 km off the Lagos→Abuja line and is *on* the
normal route. Tighten it to ~15 km once the routing provider gives real
polylines to measure against.

## Carrier sourcing

```bash
python -m logistics.cli carriers            # fleet, and who can be reached
python -m logistics.cli quotes LG-82931     # quotes and stored scores
python -m logistics.cli approvals           # what is waiting on a human
python -m logistics.cli approve <token>
python -m logistics.cli telegram-poll       # onboard carriers, parse replies
```

**Telegram, not WhatsApp** — no business verification, no Meta review, no
template approval, no lead time. The one real constraint: **a bot cannot open
a conversation**. Sending to someone who has never messaged it returns
`Forbidden: bot can't initiate conversation with a user`, so a carrier presses
Start once and `telegram-poll` captures their `chat_id`. A carrier without one
is filtered out of broadcasts rather than failing at send time. Rate limits
(~1/sec per chat, ~30/sec global) are paced client-side and 429s honour
`retry_after`.

**Scoring is canonical in Python** (`carriers/scoring.py`), stored on the quote
row, and rendered — not recomputed — by the dashboard. Two implementations of a
spend decision would drift, and the one spending money would not be the one on
screen.

The published weights have no notion of urgency, and applied literally they
prefer a cheap carrier with a 78% on-time record — cost is the largest single
weight at 30%. On a load with slack that is correct. On a tight deadline it is
not, so **on-time becomes a feasibility floor rather than a preference**: with
under 10% schedule slack a carrier needs a 90% record to bid at all, and
exclusions are recorded with a reason an operator can read.

## The agent set

| Agent | Handler | Model |
|---|---|---|
| Orchestrator | `routing.py` + `orchestrator.py` | none — a state machine |
| Order | `order.validate` | Super, after deterministic checks |
| Inventory/Warehouse | `warehouse.allocate` | none — rules, and it now really reserves |
| Shipment Planning | `planning.plan` | none — corridor selection |
| Carrier Selection | `carrier.source` → `close_window` → `book` | Super, for parsing replies only |
| Tracking | `detection.sweep` + ingest | **none, ever** |
| Exception Management | `exception.investigate` | Super, escalating to Ultra |
| Communication | `support.reply`, `customer.notify` | Nano + content-safety |
| Analytics | `analytics.report` | Ultra, batch |

Only `pod.verify` remains unregistered.

### Exception Management

The one place open-ended reasoning earns its cost. Detection is arithmetic —
late, off route, silent — but *what to do about it* is unbounded: re-source,
expedite, accept and tell the customer, split, or fetch a human.

Three layers, like the support agent: `gather.py` builds the case file in SQL,
`reason.py` makes one structured call (escalating to Ultra when unsure), and
`resolve.py` maps a resolution to work — pure, so the whole table is testable.
**Every resolution becomes a `PolicyEngine.propose`.** "Execute permitted
solutions, request approval when required" is what the gate already does.

An exception is only closed when the condition has actually cleared — never by
having been discussed.

### Analytics

**SQL computes the facts; the model explains them.** "Carrier B caused 31% of
late deliveries on 19% of volume" is a query — asking a model for that number
would be asking it to invent a statistic. Facts are stored alongside the
narrative so any claim can be checked. Below five shipments it writes nothing,
because a model asked to find a trend in four will find one.

## The support agent delegates

A customer message can cause work, not just a reply. The agent classifies what
they want and hands it to the **orchestrator** — it never calls another agent
directly, so every hand-off is a durable, replayable row in `work_items`.

```
customer message
      ↓
support.reply              intent, reply, extracted fields   (one model call)
      ↓  enqueues
support.create_shipment │ support.change_request │ support.escalate
      ↓                            ↓                      ↓
order.validate →            policy gate →            ops inbox
allocate → plan → source    /approvals
```

Three layers, deliberately separated: `view.py` is what the agent may know,
`decide.py` is what to say, `delegate.py` is what that causes. **The model
decides what to say; it never decides whether something happens.** A
misclassification produces a wrong sentence, not a wrong action — and nothing
money-moving is reachable from chat at all, which a test asserts.

Booking asks for five things (pickup, destination, what, how many, rough
weight) because those are exactly what `order.validate` treats as blocking.
What is still missing is computed in Python and handed to the model, not left
for it to work out — asked to converse *and* track state, it re-asked for a
destination it already had.

A change request never applies the change: it becomes a proposed action, and
`address_change` and `cancellation` are already approval-required, so it lands
in `/approvals`.

**Guards on chat-created shipments.** Anyone can message a bot; there is no
authentication. A contact may create 5 shipments an hour, an incomplete order
stays a draft, and every one is marked `created_via = 'CHAT'` with its
originating contact so an operator can see what came from an open channel. The
policy gate still stops all spending.

## Customer channels

Customers never see this dashboard. They message a channel, and the support
agent answers on whichever one they used.

```bash
python -m logistics.cli generate-key   # CREDENTIALS_KEY for .env
python -m logistics.cli channels       # what is connected
```

Configure them at `/settings`: Telegram bot token, WhatsApp Cloud API, a Gmail
app password, or a widget snippet for the operator's own site. Credentials live
in Postgres **encrypted with Fernet** — the key is in `CREDENTIALS_KEY` and
never in the database, so a dump of `channel_connections` yields ciphertext and
nothing else. With no key configured, saving a secret raises rather than
writing plaintext.

A channel cannot be enabled until it has verified against the real service —
enforced by a CHECK constraint, not just the UI, because a channel that looks
connected but is not silently drops customer messages.

**Matching a message to a shipment** is the hard part, since customers write
"where's my order?" with no reference. Three passes, cheapest first: a
reference in the text (a regex, not a model), then the contact's last shipment,
then — for email — an address matched to a customer with *exactly one* open
shipment. If none work the agent asks which shipment, because a confident
answer about the wrong one is the worst outcome available.

The agent sees a **curated projection**, never the shipment row.
`CustomerView` in `support.py` is an allowlist: carrier costs, quotes, scores
and policy decisions are absent by construction. Internal states collapse —
`SOURCING` and `AWAITING_APPROVAL` both read as "arranging transport", because
from outside they are the same thing.

## Safety

**Propose → gate → execute.** An agent never calls a money-moving tool. It
emits a proposed action; `PolicyEngine` — which the model cannot reach —
decides; a separate executor commits.

The gate **fails closed** in every direction:

| Situation | Decision |
|---|---|
| No active policy | `DENY` |
| Amount as a float | `DENY` |
| Amount with no currency | `DENY` |
| FX rate missing or stale | `DENY` |
| Amount present but no rule | `REQUIRE_APPROVAL` |
| Unapproved carrier, hazmat, address change, cancellation | `REQUIRE_APPROVAL` |

**Money is always `(amount_minor, currency)`.** The `Money` type refuses to add
or compare across currencies, and the policy engine converts to its base
currency *before* any comparison — a USD amount against an NGN cap would
otherwise auto-approve something ~1,500× over budget. Minor units are
per-currency: NGN and USD have two, JPY none.

**Idempotency.** Every side-effecting tool takes an idempotency key and follows
intent → commit → confirm against `tool_calls`. Agent frameworks retry; a
timeout after a carrier accepted must not double-book. A crash *between* the
intent and the result is deliberately **not** retryable — the correct move is
to ask the carrier what they already hold for that reference, never to call
again and hope. `ToolExecutor.dangling()` lists those for an operator.

**Approvals decide once.** The decision is a conditional `UPDATE` guarded on
`state = 'PENDING'`, so a double-clicked Approve at ₦650,000 cannot authorise
₦1.3M. The dashboard and the CLI perform the same two writes.

**Trust boundary.** Customer and carrier text is untrusted input reaching an
agent that can propose spending money. It is fenced as data in prompts, screened
by a guardrail model, and — the actual defense — cannot reach a Tier 3 tool
without passing the policy gate. A successful injection produces a rejected
proposal, not a booked truck.

---

## The model layer

Handlers name a **`Job`**, never a model, so re-routing is one line in
`llm/registry.py`.

| Job | Model | Reasoning |
|---|---|---|
| Order extraction | `nemotron-3-super-120b-a12b` | on |
| Exception reasoning | `nemotron-3-super-120b-a12b` | on |
| Carrier reply parsing | `nemotron-3-super-120b-a12b` | off |
| Customer chat / notification | `nemotron-3-nano-30b-a3b` | off |
| POD & waybill | `nemotron-parse` | off |
| Untrusted-text screening | `nemotron-3.5-content-safety` | off |
| Analytics | `nemotron-3-ultra-550b-a55b` | on |

Verified against the live endpoint:

- Nemotron 3 reasons by default, into a separate `reasoning_content` field.
  The toggle is `extra_body={"chat_template_kwargs": {"thinking": false}}`.
  The Llama-Nemotron `"detailed thinking off"` system prompt does **not** work.
- Reasoning costs roughly **8× latency** (2.5s → 20s on Super), which is why it
  is off for every mechanical job.
- **Truncation leaks raw chain-of-thought into `content`.** `LLMResponse.truncated`
  flags it and the retry loop asks for brevity rather than re-truncating.

Open-weight models need tighter reins than frontier ones, so: three to five
tools per call rather than twelve, constrained structured output over free tool
choice, and Pydantic validation with a bounded retry. Malformed output is an
expected outcome routed to a human, not an exception.

Schemas enforce *coherence*, not just shape. `OrderValidation` rejects
`ready_to_ship: false` with an empty issues list — observed live, and it would
have told a customer "we need more information" and nothing else.

### Production licensing

The hosted `build.nvidia.com` tier is licensed for development, testing,
research and evaluation — **not production** — and defaults to ~40 RPM against
the ~63/min this design needs at 5,000 shipments/day. Nemotron 3 ships open
weights under the NVIDIA Open Model License / OpenMDW-1.1, which permit
commercial self-hosting, so moving to vLLM is a `NVIDIA_BASE_URL` change.
Everything goes through the `LLMClient` abstraction to keep it that way.

---

## Dashboard

```bash
npm install
npm run dev        # http://localhost:3002
```

Server components read the same Postgres the worker writes to — no API layer
in between, so nothing can drift out of sync with the schema.

| Page | Route | State |
|---|---|---|
| Operations overview | `/` | live |
| Active shipments map | `/map` | live — inline SVG from `locations`, no tile server |
| Orders and requests | `/orders` | intake channels live, orders table fills with the intake service |
| Shipments | `/shipments`, `/shipments/[ref]` | live — plan, legs, allocation, full event timeline |
| Planning workspace | `/planning` | live |
| Carrier management | `/carriers` | live — the published 30/25/15/10/10/10 scoring model |
| Warehouse operations | `/warehouses` | live — stock, dispatch lead times |
| Exception control centre | `/exceptions` | shipment-level live; detection records await phase 3 |
| Customer communications | `/communications` | structure only — Communication Agent not built |
| Documents and compliance | `/documents` | structure only — Dispatch and POD not built |
| Analytics and reports | `/analytics` | live for what exists; says what it cannot yet answer |
| Approval queue | `/approvals` | live — empty until carrier booking raises approvals |
| Agent activity and audit | `/agent-activity` | live — every model call with latency, tokens, reasoning |
| Work queue | `/queue` | live |
| Settings and integrations | `/settings` | live — active policy, caps, FX, model routing |

Pages with no data yet say so and name what will fill them. A dashboard that
renders zeroes it cannot substantiate is harder to trust than one that admits
the gap.

## Layout

```
migrations/          001 core · 002 policy · 003 reference
                     004 transport · 005 operations · 006 policy fx
src/logistics/       Python — the agents and orchestrator
  domain/            states, legs, money, events, models
  llm/               client abstraction, NVIDIA NIM, routing, rate limiting
  orchestrator/      queue, routing, orchestrator, worker, policy
  handlers/          validate, allocate, plan, source, close
  db.py  shipments.py  inventory.py  seed.py  app.py  cli.py  runtime.py
app/                 Next.js — the control tower, 15 routes
lib/                 db, queries, formatting, carrier scoring
tests/               166 tests
```

---

## Development

```bash
.venv/Scripts/python.exe -m pytest -q
```

Tests use a **separate `logistics_test` database**, created automatically. They
`TRUNCATE`, so sharing with development data would silently wipe it.

On Windows, psycopg's async driver cannot run on the default
`ProactorEventLoop`. Every entry point goes through `logistics/runtime.py`,
which selects a compatible loop; use `runtime.run()` rather than
`asyncio.run()`.

---

## Status

**Built:** orchestrator spine, durable queue with lease/reclaim, policy gate
with multi-currency, model layer, multimodal data model (42 tables), the
deterministic tracking and detection engine, carrier sourcing end to end over
API and Telegram, the idempotent booking path, and the 15-page control tower.

292 tests. A shipment now walks `DRAFT → … → SOURCING → AWAITING_APPROVAL →
BOOKED` with a real quote comparison, a real policy decision and a real
human approval behind it. Separately, 42 tracking events raising 4 exceptions
cost **zero model calls**.

**Next:** `exception.investigate` — the Exception Agent, the first genuine
reasoning agent and the first to run in shadow mode. It is also the last
routed-but-unregistered handler that still strands shipments, alongside
`pod.verify`.

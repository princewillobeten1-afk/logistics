"""Demo seed data.

Development convenience only — never run against production. Populates the
reference tables the handlers read so a submitted order can actually walk the
spine: locations, warehouses with realistic dispatch lead times, stock, and a
few carriers spanning both integration styles.

Warehouse lead times are deliberately varied so the deadline-aware allocation
in `handlers/allocate.py` has something real to decide between.
"""

from __future__ import annotations

from datetime import date, timedelta

from psycopg.types.json import Jsonb

from logistics.db import Database
from logistics.obs import get_logger

log = get_logger(__name__)

# (code, name, city, country, lat, lon, dispatch_lead_hours)
WAREHOUSES = [
    ("Lagos",  "Lagos Central DC",  "Lagos",         "NG",  6.5244,  3.3792,  8.0),
    ("Ibadan", "Ibadan Depot",      "Ibadan",        "NG",  7.3775,  3.9470, 16.0),
    ("Abuja",  "Abuja Distribution", "Abuja",        "NG",  9.0765,  7.3986, 12.0),
    ("PHC",    "Port Harcourt Hub", "Port Harcourt", "NG",  4.8156,  7.0498, 10.0),
]

# (type, name, code, city, country, lat, lon)
GATEWAYS = [
    ("PORT",    "Apapa Port",              "NGAPP", "Lagos",         "NG",  6.4488,  3.3596),
    ("PORT",    "Onne Port",               "NGONN", "Port Harcourt", "NG",  4.7167,  7.1500),
    ("AIRPORT", "Murtala Muhammed Cargo",  "LOS",   "Lagos",         "NG",  6.5774,  3.3212),
    ("AIRPORT", "Nnamdi Azikiwe Cargo",    "ABV",   "Abuja",         "NG",  9.0068,  7.2632),
    ("PORT",    "Tema Port",               "GHTEM", "Tema",          "GH",  5.6167,  0.0167),
    ("AIRPORT", "Heathrow Cargo",          "LHR",   "London",        "GB", 51.4700, -0.4543),
]

# (code, name, modes, integration, approved, on_time, damage, availability, service)
#
# The TELEGRAM ones start unreachable on purpose: a bot cannot open a
# conversation, so they stay out of broadcasts until someone presses Start and
# `telegram-onboard` captures their chat_id. That is the real onboarding state.
CARRIERS = [
    ("CARRIER-A", "Sahel Haulage",      ["ROAD"],        "API",      True,  0.91, 0.02, 0.85, 0.88),
    ("CARRIER-B", "Delta Freight",      ["ROAD"],        "TELEGRAM", True,  0.83, 0.05, 0.95, 0.72),
    ("CARRIER-C", "Premier Logistics",  ["ROAD"],        "API",      True,  0.97, 0.01, 0.70, 0.94),
    ("CARRIER-D", "Gulf Lines",         ["SEA"],         "EMAIL",    True,  0.88, 0.03, 0.80, 0.81),
    ("CARRIER-E", "TransWest Air",      ["AIR"],         "API",      True,  0.94, 0.02, 0.60, 0.90),
    ("CARRIER-F", "Quickmove Ventures", ["ROAD"],        "TELEGRAM", False, 0.75, 0.09, 0.99, 0.60),
]

STOCK = {"Lagos": 130, "Ibadan": 20, "Abuja": 80, "PHC": 45}

# (code, name, sla_hours, payment_terms, currency, contact_name, email, phone)
#
# SLA hours vary deliberately. It is the contractual promise the detectors
# measure against, so a 24-hour customer and a 96-hour customer on the same
# Lagos-Abuja lane produce genuinely different urgency — and the carrier
# scoring floor in `carriers/scoring.py` only bites when slack is thin.
CUSTOMERS = [
    ("ACME",    "Acme Manufacturing",  24, "Net 30", "NGN",
     "Adaeze Okonkwo", "ops@acme.example",       "+234 801 000 0001"),
    ("BLUEPEAK", "Bluepeak Retail",    48, "Net 14", "NGN",
     "Tunde Bakare",   "logistics@bluepeak.example", "+234 802 000 0002"),
    ("CORAL",   "Coral Pharmaceuticals", 12, "Prepaid", "NGN",
     "Ngozi Eze",      "supply@coral.example",   "+234 803 000 0003"),
    ("DELTAGO", "Delta Goods Ltd",     96, "Net 45", "NGN",
     "Ibrahim Musa",   "shipping@deltago.example", "+234 804 000 0004"),
    ("EVEREST", "Everest Imports",     72, "Net 30", "USD",
     "Sarah Whitfield", "ops@everest.example",   "+44 20 7000 0005"),
]

# (carrier_code, mode, kind, registration, capacity_kg, capacity_cbm, reefer, hazmat)
#
# Only carriers we can actually reach get vehicles. A fleet listing that
# includes trucks belonging to a haulier who has never pressed Start on the
# bot is a list of things that cannot be dispatched.
CONVEYANCES = [
    ("CARRIER-A", "ROAD", "RIGID_TRUCK",   "LAG-114-XA", 12_000, 42,  False, False),
    ("CARRIER-A", "ROAD", "ARTICULATED",   "LAG-227-XB", 30_000, 86,  False, True),
    ("CARRIER-A", "ROAD", "REEFER",        "LAG-318-XC", 18_000, 54,  True,  False),
    ("CARRIER-C", "ROAD", "ARTICULATED",   "ABJ-402-YA", 32_000, 90,  False, False),
    ("CARRIER-C", "ROAD", "RIGID_TRUCK",   "ABJ-511-YB", 10_000, 36,  False, False),
    ("CARRIER-B", "ROAD", "VAN",           "PHC-620-ZA",  3_500, 14,  False, False),
    ("CARRIER-E", "AIR",  "FREIGHTER",     "5N-TWA",     40_000, 320, False, False),
    ("CARRIER-D", "SEA",  "CONTAINER_SHIP", "IMO-9218471", 900_000, 4200, True, True),
]

# (carrier_code, name, phone, licence, hazmat, expiry_months)
DRIVERS = [
    ("CARRIER-A", "Emeka Nwosu",     "+234 810 111 0001", "LAG-DL-88213", True,  18),
    ("CARRIER-A", "Fatima Bello",    "+234 810 111 0002", "LAG-DL-77104", False, 7),
    # Expires inside the month. Licence expiry is a dispatch constraint, and a
    # fleet page that does not surface it lets someone assign a driver who
    # cannot legally take the load.
    ("CARRIER-A", "Segun Adeyemi",   "+234 810 111 0003", "LAG-DL-65590", False, 1),
    ("CARRIER-C", "Hauwa Suleiman",  "+234 810 111 0004", "ABJ-DL-33127", True,  24),
    ("CARRIER-C", "Chidi Okafor",    "+234 810 111 0005", "ABJ-DL-41882", False, 11),
    ("CARRIER-B", "Yusuf Danjuma",   "+234 810 111 0006", "PHC-DL-20945", False, 5),
]


async def seed_demo(db: Database) -> dict[str, int]:
    counts = {
        "locations": 0, "warehouses": 0, "inventory": 0, "carriers": 0,
        "customers": 0, "conveyances": 0, "drivers": 0,
    }

    async with db.transaction() as conn:
        for code, name, city, country, lat, lon, lead in WAREHOUSES:
            cur = await conn.execute(
                """
                INSERT INTO locations (type, name, code, city, country, latitude, longitude)
                VALUES ('WAREHOUSE', %s, %s, %s, %s, %s, %s)
                ON CONFLICT (org_id, type, code) WHERE code IS NOT NULL
                DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                (name, code, city, country, lat, lon),
            )
            location_id = (await cur.fetchone())["id"]
            counts["locations"] += 1

            cur = await conn.execute(
                """
                INSERT INTO warehouses (code, name, location_id, dispatch_lead_hours)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (org_id, code) DO UPDATE
                    SET location_id = EXCLUDED.location_id,
                        dispatch_lead_hours = EXCLUDED.dispatch_lead_hours
                RETURNING id
                """,
                (code, name, location_id, lead),
            )
            warehouse_id = (await cur.fetchone())["id"]
            counts["warehouses"] += 1

            await conn.execute(
                """
                INSERT INTO inventory (warehouse_id, sku, on_hand, reserved)
                VALUES (%s, 'DEFAULT', %s, 0)
                ON CONFLICT (warehouse_id, sku) DO UPDATE SET on_hand = EXCLUDED.on_hand
                """,
                (warehouse_id, STOCK.get(code, 0)),
            )
            counts["inventory"] += 1

        for type_, name, code, city, country, lat, lon in GATEWAYS:
            await conn.execute(
                """
                INSERT INTO locations (type, name, code, city, country, latitude, longitude)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (org_id, type, code) WHERE code IS NOT NULL
                DO UPDATE SET name = EXCLUDED.name
                """,
                (type_, name, code, city, country, lat, lon),
            )
            counts["locations"] += 1

        for code, name, modes, integration, approved, on_time, damage, avail, service in CARRIERS:
            cur = await conn.execute(
                """
                INSERT INTO carriers (code, name, modes, integration, approved)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (org_id, code) DO UPDATE
                    SET name = EXCLUDED.name, modes = EXCLUDED.modes,
                        integration = EXCLUDED.integration, approved = EXCLUDED.approved
                RETURNING id
                """,
                (code, name, modes, integration, approved),
            )
            carrier_id = (await cur.fetchone())["id"]
            counts["carriers"] += 1

            await conn.execute(
                """
                INSERT INTO carrier_performance
                    (carrier_id, shipments_count, on_time_rate, damage_rate,
                     availability_rate, service_score)
                VALUES (%s, 250, %s, %s, %s, %s)
                ON CONFLICT (carrier_id, COALESCE(origin_region, ''),
                             COALESCE(destination_region, ''), COALESCE(mode, ''))
                DO UPDATE SET on_time_rate = EXCLUDED.on_time_rate,
                              damage_rate = EXCLUDED.damage_rate,
                              availability_rate = EXCLUDED.availability_rate,
                              service_score = EXCLUDED.service_score
                """,
                (carrier_id, on_time, damage, avail, service),
            )

        for code, name, sla, terms, currency, contact, email, phone in CUSTOMERS:
            await conn.execute(
                """
                INSERT INTO customers
                    (code, name, sla_hours, payment_terms, default_currency, contacts)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (org_id, code) DO UPDATE
                    SET name = EXCLUDED.name,
                        sla_hours = EXCLUDED.sla_hours,
                        payment_terms = EXCLUDED.payment_terms,
                        contacts = EXCLUDED.contacts
                """,
                (
                    code, name, sla, terms, currency,
                    Jsonb([{"name": contact, "email": email, "phone": phone,
                            "role": "primary"}]),
                ),
            )
            counts["customers"] += 1

        # Vehicles and drivers hang off carriers, so resolve those once.
        cur = await conn.execute("SELECT code, id FROM carriers")
        carrier_ids = {r["code"]: r["id"] for r in await cur.fetchall()}

        for code, mode, kind, reg, kg, cbm, reefer, hazmat in CONVEYANCES:
            carrier_id = carrier_ids.get(code)
            if carrier_id is None:
                continue
            # No natural key on conveyances, so identity is the registration
            # inside `identifiers`. Matching on it keeps re-seeding idempotent
            # rather than growing the fleet on every run.
            cur = await conn.execute(
                "SELECT id FROM conveyances WHERE identifiers->>'registration' = %s",
                (reg,),
            )
            existing = await cur.fetchone()
            if existing:
                await conn.execute(
                    "UPDATE conveyances SET carrier_id = %s, mode = %s, kind = %s,"
                    "       capacity_kg = %s, capacity_cbm = %s, reefer = %s,"
                    "       hazmat_certified = %s WHERE id = %s",
                    (carrier_id, mode, kind, kg, cbm, reefer, hazmat, existing["id"]),
                )
            else:
                await conn.execute(
                    """
                    INSERT INTO conveyances
                        (carrier_id, mode, kind, identifiers, capacity_kg,
                         capacity_cbm, reefer, hazmat_certified)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (carrier_id, mode, kind, Jsonb({"registration": reg}),
                     kg, cbm, reefer, hazmat),
                )
            counts["conveyances"] += 1

        for code, name, phone, licence, hazmat, months in DRIVERS:
            carrier_id = carrier_ids.get(code)
            if carrier_id is None:
                continue
            cur = await conn.execute(
                "SELECT id FROM drivers WHERE licence_number = %s", (licence,)
            )
            existing = await cur.fetchone()
            expiry = date.today() + timedelta(days=30 * months)
            if existing:
                await conn.execute(
                    "UPDATE drivers SET carrier_id = %s, name = %s, phone = %s,"
                    "       hazmat_certified = %s, licence_expiry = %s WHERE id = %s",
                    (carrier_id, name, phone, hazmat, expiry, existing["id"]),
                )
            else:
                await conn.execute(
                    """
                    INSERT INTO drivers
                        (carrier_id, name, phone, licence_number,
                         licence_expiry, hazmat_certified)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (carrier_id, name, phone, licence, expiry, hazmat),
                )
            counts["drivers"] += 1

    log.info("seed.complete", **counts)
    return counts

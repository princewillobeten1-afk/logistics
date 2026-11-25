"""WPCargo shipment form client for the Customer Support Agent.

When a customer provides their shipment and contact details to the support
agent, this module authenticates against the configured WordPress WPCargo
admin portal (`/wp-admin/post-new.php?post_type=wpcargo_shipment`), fills in
the Shipper, Receiver, Shipment, Status, and Package fields, and publishes the
shipment record before the support agent hands off to the Orchestrator.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from html.parser import HTMLParser
from typing import Any

import httpx

from logistics.config import Settings
from logistics.obs import get_logger

log = get_logger(__name__)

_TITLE_SCRIPT_RE = re.compile(
    r"""\$\(\s*["']#titlewrap\s+#title["']\s*\)\.val\(\s*["']([^"']+)["']\s*\)"""
)


@dataclass(frozen=True, slots=True)
class WPCargoSubmission:
    post_id: str
    reference: str
    edit_url: str


class _PostFormParser(HTMLParser):
    """Extract hidden and default fields from the WordPress `#post` form."""

    def __init__(self) -> None:
        super().__init__()
        self.in_post_form = False
        self.hidden_fields: dict[str, str] = {}
        self.default_values: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        d = {k: (v or "") for k, v in attrs}
        if tag == "form" and d.get("id") == "post":
            self.in_post_form = True
            return
        if not self.in_post_form:
            return
        if tag == "input":
            name = d.get("name", "")
            if not name:
                return
            input_type = d.get("type", "text").lower()
            value = d.get("value", "")
            if input_type == "hidden":
                self.hidden_fields[name] = value
            elif input_type in ("text", "number", "email") and value:
                self.default_values[name] = value
            elif input_type == "radio" and "checked" in d:
                self.default_values[name] = value

    def handle_endtag(self, tag: str) -> None:
        if tag == "form" and self.in_post_form:
            self.in_post_form = False


def parse_wpcargo_form(html: str) -> tuple[dict[str, str], str | None]:
    """Return `(form_defaults, generated_reference)` from `post-new.php` HTML."""
    parser = _PostFormParser()
    parser.feed(html)

    match = _TITLE_SCRIPT_RE.search(html)
    generated_ref = match.group(1).strip() if match else None

    merged = {**parser.default_values, **parser.hidden_fields}
    return merged, generated_ref


def build_wpcargo_payload(
    form_defaults: dict[str, str],
    order: dict[str, Any],
    *,
    reference: str,
) -> dict[str, str]:
    """Map collected customer support `OrderDraft` fields to WPCargo form inputs."""
    today = datetime.now(UTC).date().isoformat()
    deadline_raw = str(order.get("deadline") or "").strip()
    expected_delivery = deadline_raw[:10] if len(deadline_raw) >= 10 else ""

    weight_val = order.get("weight_kg")
    weight_str = f"{weight_val} kg" if weight_val is not None else ""
    qty_str = str(order.get("quantity") or 1)
    piece_type = str(order.get("piece_type") or "Carton")
    description = str(order.get("description") or "")

    pickup = str(order.get("pickup") or "")
    destination = str(order.get("destination") or "")
    origin_country = str(order.get("origin_country") or _infer_country(pickup))
    dest_country = str(order.get("destination_country") or _infer_country(destination))

    mode = str(order.get("mode") or _infer_mode(weight_val, origin_country, dest_country))
    shipment_type = str(
        order.get("shipment_type")
        or _infer_shipment_type(weight_val, origin_country, dest_country)
    )

    payload: dict[str, str] = {
        **form_defaults,
        "action": "editpost",
        "originalaction": "editpost",
        "post_type": "wpcargo_shipment",
        "post_title": reference,
        "post_status": "publish",
        "publish": "Publish",
        "original_publish": "Publish",
        # Shipper Details
        "wpcargo_shipper_name": str(order.get("shipper_name") or ""),
        "wpcargo_shipper_phone": str(order.get("shipper_phone") or ""),
        "wpcargo_shipper_address": pickup,
        "wpcargo_shipper_email": str(order.get("shipper_email") or ""),
        # Receiver Details
        "wpcargo_receiver_name": str(order.get("receiver_name") or ""),
        "wpcargo_receiver_phone": str(order.get("receiver_phone") or ""),
        "wpcargo_receiver_address": destination,
        "wpcargo_receiver_email": str(order.get("receiver_email") or ""),
        # Shipment Details
        "wpcargo_type_of_shipment": shipment_type,
        "wpcargo_weight": weight_str,
        "wpcargo_courier": str(order.get("courier") or "SwiftParcel Control Tower"),
        "wpcargo_packages": piece_type,
        "wpcargo_mode_field": mode,
        "wpcargo_product": description,
        "wpcargo_qty": qty_str,
        "payment_wpcargo_mode_field": str(order.get("payment_mode") or "BACS"),
        "wpcargo_total_freight": str(order.get("total_freight") or ""),
        "wpcargo_carrier_field": str(order.get("carrier_field") or ""),
        "wpcargo_carrier_ref_number": reference,
        "wpcargo_departure_time_picker": "09:00 am",
        "wpcargo_origin_field": origin_country,
        "wpcargo_destination": dest_country,
        "wpcargo_pickup_date_picker": today,
        "wpcargo_pickup_time_picker": "09:00 am",
        "wpcargo_expected_delivery_date_picker": expected_delivery,
        "wpcargo_comments": str(
            order.get("comments")
            or f"Submitted via AI Customer Support Agent — {qty_str}x {description} ({weight_str})"
        ),
        # Current Status / History metabox + core wpcargo_status meta
        "wpcargo_status": str(order.get("status") or "Pending"),
        "date": form_defaults.get("date") or today,
        "time": form_defaults.get("time") or "09:00 am",
        "location": pickup,
        "status": str(order.get("status") or "Pending"),
        "remarks": str(
            order.get("remarks")
            or "Order received by Customer Support Agent and delegated to Orchestrator."
        ),
        # Multiple Package repeater (first row)
        "wpc-multiple-package[0][wpc-pm-qty]": qty_str,
        "wpc-multiple-package[0][wpc-pm-piece-type]": piece_type,
        "wpc-multiple-package[0][wpc-pm-description]": description,
        "wpc-multiple-package[0][wpc-pm-length]": str(order.get("length_cm") or ""),
        "wpc-multiple-package[0][wpc-pm-width]": str(order.get("width_cm") or ""),
        "wpc-multiple-package[0][wpc-pm-height]": str(order.get("height_cm") or ""),
        "wpc-multiple-package[0][wpc-pm-weight]": (
            str(weight_val) if weight_val is not None else ""
        ),
    }
    return payload


async def submit_wpcargo_shipment(
    settings: Settings,
    order: dict[str, Any],
    *,
    fallback_reference: str,
) -> WPCargoSubmission:
    """Log into WordPress admin, open `post-new.php?post_type=wpcargo_shipment`,
    fill in the customer & shipment fields, and publish the shipment post."""
    if not settings.has_wpcargo or not settings.wpcargo_url or not settings.wpcargo_password:
        raise RuntimeError("WPCargo credentials are not configured in Settings")

    base_url = settings.wpcargo_url.rstrip("/")
    login_url = f"{base_url}/wp-login.php"
    new_post_url = f"{base_url}/wp-admin/post-new.php?post_type=wpcargo_shipment"
    submit_url = f"{base_url}/wp-admin/post.php"

    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        # 1. Prime WordPress login cookie
        await client.get(login_url)

        # 2. Authenticate and redirect to the WPCargo shipment creation screen
        resp = await client.post(
            login_url,
            data={
                "log": settings.wpcargo_username or "",
                "pwd": settings.wpcargo_password.get_secret_value(),
                "wp-submit": "Log In",
                "redirect_to": new_post_url,
                "testcookie": "1",
            },
            headers={"Origin": base_url, "Referer": login_url},
        )
        resp.raise_for_status()

        if "wp-login.php" in str(resp.url):
            raise RuntimeError("WPCargo WordPress authentication failed (redirected to wp-login.php)")

        form_defaults, generated_ref = parse_wpcargo_form(resp.text)
        post_id = form_defaults.get("post_ID")
        if not post_id:
            raise RuntimeError("Could not find post_ID on WPCargo shipment form")

        reference = (generated_ref or fallback_reference).strip()
        payload = build_wpcargo_payload(form_defaults, order, reference=reference)

        # 3. Submit the `#post` form to `/wp-admin/post.php`
        post_resp = await client.post(
            submit_url,
            data=payload,
            headers={"Origin": base_url, "Referer": new_post_url},
        )
        post_resp.raise_for_status()
        if "wp-login.php" in str(post_resp.url):
            raise RuntimeError("WPCargo session expired during shipment submission")
        if 'id="error-page"' in post_resp.text or "wp-die-message" in post_resp.text:
            raise RuntimeError("WPCargo WordPress rejected shipment submission (wp-die)")

        edit_url = f"{base_url}/wp-admin/post.php?post={post_id}&action=edit"
        log.info(
            "wpcargo.shipment_published",
            post_id=post_id,
            reference=reference,
            edit_url=edit_url,
        )
        return WPCargoSubmission(
            post_id=str(post_id),
            reference=reference,
            edit_url=edit_url,
        )


_STATE_TO_WPCARGO_STATUS: dict[str, str] = {
    "DRAFT": "Pending",
    "NEEDS_INFO": "On Hold",
    "VALIDATED": "Pending",
    "ALLOCATED": "Pending",
    "PLANNED": "Pending",
    "SOURCING": "Pending",
    "AWAITING_APPROVAL": "Pending",
    "BOOKED": "Picked Up",
    "IN_TRANSIT": "In Transit",
    "EXCEPTION": "On Hold",
    "DELIVERED": "Delivered",
    "POD_VERIFIED": "Delivered",
    "CLOSED": "Delivered",
    "CANCELLED": "Cancelled",
    "FAILED": "Cancelled",
}


def status_for_shipment_state(state: str) -> str:
    """Map an internal `ShipmentState` string to a standard WPCargo status."""
    return _STATE_TO_WPCARGO_STATUS.get(str(state).upper(), "Pending")


_COUNTRY_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Ghana", ("ghana", "accra", "tema", "kumasi", "takoradi")),
    ("Cote d'Ivoire", ("ivory coast", "cote d'ivoire", "abidjan", "san-pedro")),
    ("Benin", ("benin", "cotonou", "porto-novo")),
    ("Togo", ("togo", "lome", "lomé")),
    ("Senegal", ("senegal", "dakar")),
    ("Cameroon", ("cameroon", "douala", "yaounde")),
    ("Kenya", ("kenya", "nairobi", "mombasa")),
    ("South Africa", ("south africa", "johannesburg", "cape town", "durban")),
    ("United Kingdom", ("united kingdom", "uk", "london", "manchester", "heathrow", "felixstowe")),
    ("Netherlands", ("netherlands", "rotterdam", "amsterdam", "schiphol")),
    ("Germany", ("germany", "hamburg", "frankfurt", "berlin", "munich")),
    ("France", ("france", "paris", "le havre", "marseille")),
    ("Belgium", ("belgium", "antwerp", "brussels")),
    ("United Arab Emirates", ("uae", "dubai", "abu dhabi", "jebel ali")),
    ("China", ("china", "shanghai", "shenzhen", "guangzhou", "ningbo", "beijing")),
    ("India", ("india", "mumbai", "delhi", "chennai")),
    ("Singapore", ("singapore",)),
    ("United States", ("united states", "usa", "new york", "houston", "los angeles", "miami", "chicago")),
    ("Canada", ("canada", "toronto", "vancouver", "montreal")),
)


def _infer_country(address: str) -> str:
    lowered = (address or "").lower()
    for country, keywords in _COUNTRY_KEYWORDS:
        if any(re.search(rf"\b{re.escape(k)}\b", lowered) for k in keywords):
            return country
    return "Nigeria"


def _infer_mode(weight_kg: Any, origin_country: str, dest_country: str) -> str:
    if origin_country != dest_country:
        try:
            if float(weight_kg or 0) >= 2000:
                return "Sea Transport"
        except (TypeError, ValueError):
            pass
        return "Air Freight"
    return "Land Shipping"


def _infer_shipment_type(weight_kg: Any, origin_country: str, dest_country: str) -> str:
    if origin_country != dest_country:
        return "International Shipping"
    try:
        if float(weight_kg or 0) >= 1000:
            return "Truckload"
    except (TypeError, ValueError):
        pass
    return "Van Move"


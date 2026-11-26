"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, Sparkles } from "lucide-react";
import {
  createCarrierAction,
  createCustomerAction,
  createDriverAction,
  createVehicleAction,
  createWarehouseAction,
  initializeStarterNetworkAction,
} from "@/app/network-actions";

export function StarterNetworkButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="row-center" style={{ gap: 10, flexWrap: "wrap" }}>
      <button
        type="button"
        className={compact ? "btn btn-ghost" : "btn btn-primary"}
        disabled={pending}
        onClick={() => {
          setNotice(null);
          startTransition(async () => {
            const res = await initializeStarterNetworkAction();
            setNotice({ ok: res.ok, text: res.message });
            if (res.ok) router.refresh();
          });
        }}
      >
        <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
        <span>{pending ? "Initializing…" : "Initialize Starter Network"}</span>
      </button>
      {notice ? (
        <span className={notice.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
          {notice.text}
        </span>
      ) : null}
    </div>
  );
}

export function AddCarrierForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState("ROAD");
  const [integration, setIntegration] = useState("API");
  const [approved, setApproved] = useState(true);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      const res = await createCarrierAction({
        code,
        name,
        modes: mode === "MULTIMODAL" ? ["ROAD", "AIR", "SEA"] : [mode],
        integration,
        approved,
      });
      setFeedback({ ok: res.ok, text: res.message });
      if (res.ok) {
        setCode("");
        setName("");
        router.refresh();
      }
    });
  }

  return (
    <form className="intake-form" onSubmit={onSubmit}>
      <div className="intake-grid">
        <label htmlFor="carrier-code">
          <span>Carrier code</span>
          <input id="carrier-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. DHL-EXP" required />
        </label>
        <label htmlFor="carrier-name">
          <span>Carrier name</span>
          <input id="carrier-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DHL Global Forwarding" required />
        </label>
        <label htmlFor="carrier-mode">
          <span>Mode</span>
          <select id="carrier-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="ROAD">Road freight</option>
            <option value="AIR">Air cargo</option>
            <option value="SEA">Sea freight</option>
            <option value="MULTIMODAL">Multimodal (Road/Air/Sea)</option>
          </select>
        </label>
        <label htmlFor="carrier-int">
          <span>Integration</span>
          <select id="carrier-int" value={integration} onChange={(e) => setIntegration(e.target.value)}>
            <option value="API">API</option>
            <option value="EMAIL">Email</option>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="MANUAL">Manual</option>
          </select>
        </label>
        <label htmlFor="carrier-approved" className="row-center" style={{ gap: 8, alignSelf: "end", paddingBottom: 8 }}>
          <input id="carrier-approved" type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
          <span>Approved</span>
        </label>
      </div>
      <div className="intake-footer">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
          <span>{pending ? "Saving…" : "Add carrier"}</span>
        </button>
        {feedback ? (
          <span className={feedback.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
            {feedback.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function AddWarehouseForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("NG");
  const [leadHours, setLeadHours] = useState("8");
  const [initialStock, setInitialStock] = useState("150");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      const res = await createWarehouseAction({
        code,
        name,
        city,
        country,
        leadHours: Number(leadHours),
        initialStock: Number(initialStock),
      });
      setFeedback({ ok: res.ok, text: res.message });
      if (res.ok) {
        setCode("");
        setName("");
        setCity("");
        router.refresh();
      }
    });
  }

  return (
    <form className="intake-form" onSubmit={onSubmit}>
      <div className="intake-grid">
        <label htmlFor="wh-code">
          <span>Code</span>
          <input id="wh-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. Lagos" required />
        </label>
        <label htmlFor="wh-name">
          <span>Warehouse name</span>
          <input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ikeja Fulfillment DC" required />
        </label>
        <label htmlFor="wh-city">
          <span>City</span>
          <input id="wh-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Lagos" required />
        </label>
        <label htmlFor="wh-country">
          <span>Country (ISO-2)</span>
          <input id="wh-country" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} placeholder="NG" />
        </label>
        <label htmlFor="wh-lead">
          <span>Lead time (h)</span>
          <input id="wh-lead" type="number" min={1} value={leadHours} onChange={(e) => setLeadHours(e.target.value)} />
        </label>
        <label htmlFor="wh-stock">
          <span>Initial stock (units)</span>
          <input id="wh-stock" type="number" min={0} value={initialStock} onChange={(e) => setInitialStock(e.target.value)} />
        </label>
      </div>
      <div className="intake-footer">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
          <span>{pending ? "Saving…" : "Add warehouse"}</span>
        </button>
        {feedback ? (
          <span className={feedback.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
            {feedback.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function AddFleetForms() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reg, setReg] = useState("");
  const [mode, setMode] = useState("ROAD");
  const [kind, setKind] = useState("RIGID_TRUCK");
  const [capacityKg, setCapacityKg] = useState("15000");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [driverLicence, setDriverLicence] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="grid-2">
      <form
        className="intake-form"
        onSubmit={(e) => {
          e.preventDefault();
          setFeedback(null);
          startTransition(async () => {
            const res = await createVehicleAction({
              registration: reg,
              mode,
              kind,
              capacityKg: Number(capacityKg),
              reefer: kind === "REEFER",
              hazmat: false,
            });
            setFeedback({ ok: res.ok, text: res.message });
            if (res.ok) {
              setReg("");
              router.refresh();
            }
          });
        }}
      >
        <div className="intake-grid">
          <label htmlFor="veh-reg">
            <span>Vehicle registration</span>
            <input id="veh-reg" value={reg} onChange={(e) => setReg(e.target.value)} placeholder="e.g. LAG-701-XC" required />
          </label>
          <label htmlFor="veh-mode">
            <span>Mode</span>
            <select id="veh-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="ROAD">Road</option>
              <option value="AIR">Air</option>
              <option value="SEA">Sea</option>
              <option value="RAIL">Rail</option>
            </select>
          </label>
          <label htmlFor="veh-kind">
            <span>Type</span>
            <select id="veh-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="RIGID_TRUCK">Rigid truck</option>
              <option value="ARTICULATED">Articulated</option>
              <option value="VAN">Van</option>
              <option value="REEFER">Reefer</option>
              <option value="FREIGHTER">Freighter</option>
              <option value="CONTAINER_SHIP">Container ship</option>
            </select>
          </label>
          <label htmlFor="veh-cap">
            <span>Capacity (kg)</span>
            <input id="veh-cap" type="number" min={100} value={capacityKg} onChange={(e) => setCapacityKg(e.target.value)} />
          </label>
        </div>
        <div className="intake-footer">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            <span>Add vehicle</span>
          </button>
        </div>
      </form>

      <form
        className="intake-form"
        onSubmit={(e) => {
          e.preventDefault();
          setFeedback(null);
          startTransition(async () => {
            const res = await createDriverAction({
              name: driverName,
              phone: driverPhone,
              licence: driverLicence,
              hazmat: false,
            });
            setFeedback({ ok: res.ok, text: res.message });
            if (res.ok) {
              setDriverName("");
              setDriverPhone("");
              setDriverLicence("");
              router.refresh();
            }
          });
        }}
      >
        <div className="intake-grid">
          <label htmlFor="drv-name">
            <span>Driver name</span>
            <input id="drv-name" value={driverName} onChange={(e) => setDriverName(e.target.value)} placeholder="e.g. Musa Bello" required />
          </label>
          <label htmlFor="drv-phone">
            <span>Phone</span>
            <input id="drv-phone" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} placeholder="+234 800..." />
          </label>
          <label htmlFor="drv-lic">
            <span>Licence number</span>
            <input id="drv-lic" value={driverLicence} onChange={(e) => setDriverLicence(e.target.value)} placeholder="LAG-DL-9012" />
          </label>
        </div>
        <div className="intake-footer">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            <span>Add driver</span>
          </button>
          {feedback ? (
            <span className={feedback.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
              {feedback.text}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export function AddCustomerForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [slaHours, setSlaHours] = useState("48");
  const [paymentTerms, setPaymentTerms] = useState("Net 30");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      className="intake-form"
      onSubmit={(e) => {
        e.preventDefault();
        setFeedback(null);
        startTransition(async () => {
          const res = await createCustomerAction({
            code,
            name,
            slaHours: Number(slaHours),
            paymentTerms,
            contactEmail: email,
            contactPhone: phone,
          });
          setFeedback({ ok: res.ok, text: res.message });
          if (res.ok) {
            setCode("");
            setName("");
            setEmail("");
            setPhone("");
            router.refresh();
          }
        });
      }}
    >
      <div className="intake-grid">
        <label htmlFor="cust-code">
          <span>Code</span>
          <input id="cust-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. MERIDIAN" required />
        </label>
        <label htmlFor="cust-name">
          <span>Company name</span>
          <input id="cust-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Meridian Aerospace UK" required />
        </label>
        <label htmlFor="cust-sla">
          <span>SLA (hours)</span>
          <input id="cust-sla" type="number" min={4} value={slaHours} onChange={(e) => setSlaHours(e.target.value)} />
        </label>
        <label htmlFor="cust-terms">
          <span>Payment terms</span>
          <input id="cust-terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="Net 30" />
        </label>
        <label htmlFor="cust-email">
          <span>Contact email</span>
          <input id="cust-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@customer.com" />
        </label>
        <label htmlFor="cust-phone">
          <span>Phone</span>
          <input id="cust-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+234 800..." />
        </label>
      </div>
      <div className="intake-footer">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
          <span>{pending ? "Saving…" : "Add customer"}</span>
        </button>
        {feedback ? (
          <span className={feedback.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
            {feedback.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}

-- 022_driver_telemetry_hos.sql — live GPS positioning, HOS clocks, and equipment matching for drivers.
--
-- Enables dispatchers and fleet agents to locate nearby available drivers,
-- verify Hours-of-Service (HOS) compliance before dispatch, and match
-- equipment/reefer/payload capability against live shipment pickups.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS duty_status TEXT NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_lat NUMERIC(9, 6);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_lon NUMERIC(9, 6);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_city TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_ping_at TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS hos_drive_remaining_hours NUMERIC(4, 1) NOT NULL DEFAULT 9.5;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS hos_duty_remaining_hours NUMERIC(4, 1) NOT NULL DEFAULT 12.0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_registration TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS equipment_type TEXT NOT NULL DEFAULT 'DRY_VAN';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS reefer_capable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS max_payload_kg NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drivers_duty_status_known'
  ) THEN
    ALTER TABLE drivers
      ADD CONSTRAINT drivers_duty_status_known
      CHECK (duty_status IN ('AVAILABLE', 'ON_ROUTE', 'RESTING', 'OFF_DUTY'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS drivers_geo_status_idx
  ON drivers (active, duty_status, current_lat, current_lon);

INSERT INTO schema_migrations (version) VALUES ('022_driver_telemetry_hos')
  ON CONFLICT (version) DO NOTHING;

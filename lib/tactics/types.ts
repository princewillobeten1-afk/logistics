export type TacticId =
  | "communications"
  | "collaboration"
  | "precision_tracking"
  | "in_transit"
  | "postponement"
  | "mixed_shipments"
  | "pre_arrival_customs";

export type TacticHealthStatus = "ACTIVE" | "ATTENTION" | "READY";

export type CommunicationCadence = "WEEKLY" | "BIWEEKLY" | "MONTHLY";

export interface SupplierPlanSync {
  id: string;
  supplierName: string;
  supplierCode: string;
  contactName: string;
  cadence: CommunicationCadence;
  channel: "VIDEO_CALL" | "EMAIL" | "EDI_PORTAL" | "PHONE";
  topic: string;
  demandPlanSummary: string;
  lastSyncedAt: string;
  nextSyncDueAt: string;
  status: "ON_TRACK" | "DUE_SOON" | "OVERDUE";
  loggedBy: string;
}

export type PdcaStage = "PLAN" | "DO" | "CHECK" | "ACT";

export interface SupplierImprovementInitiative {
  id: string;
  supplierName: string;
  trendObservation: string;
  metricTracked: string;
  baselineValue: string;
  targetValue: string;
  stage: PdcaStage;
  sharedWithSupplier: boolean;
  owner: string;
  updatedAt: string;
}

export type ScanCheckpoint =
  | "RECEIVING"
  | "PUTAWAY"
  | "PICKING"
  | "CROSS_DOCK"
  | "IN_TRANSIT"
  | "DELIVERED";

export interface InventoryBarcodeScan {
  id: string;
  barcode: string;
  sku: string;
  warehouseCode: string;
  checkpoint: ScanCheckpoint;
  expectedQty: number;
  scannedQty: number;
  variance: number;
  gpsLat: number;
  gpsLon: number;
  locationLabel: string;
  scannedBy: string;
  scannedAt: string;
}

export interface FlowThroughCandidate {
  sku: string;
  warehouseCode: string;
  onHand: number;
  reserved: number;
  available: number;
  unitValueMajor: number;
  mode: "STATIC_STORAGE" | "CROSS_DOCK_FLOW";
  monthlyHoldingCostMajor: number;
  projectedMonthlySavingsMajor: number;
}

export interface InTransitMetrics {
  warehouseUnits: number;
  inTransitUnits: number;
  totalUnits: number;
  inTransitRatioPct: number;
  targetRatioPct: number;
  estimatedWarehouseValueMajor: number;
  estimatedInTransitValueMajor: number;
  annualCarryingCostRatePct: number;
  monthlyCarryingSavingsMajor: number;
  crossDockEnabledSkus: number;
  candidates: FlowThroughCandidate[];
}

export type PostponementOrderStage =
  | "BASE_STOCK_HELD"
  | "ORDER_COMMITTED"
  | "ASSEMBLING"
  | "READY_TO_SHIP";

export interface PostponementCenterStatus {
  warehouseCode: string;
  warehouseName: string;
  city: string;
  country: string;
  enabled: boolean;
  dispatchLeadHours: number;
  baseUnitsHeld: number;
  activeWorkOrders: number;
}

export interface PostponementWorkOrder {
  id: string;
  warehouseCode: string;
  customerName: string;
  baseSku: string;
  finalConfiguration: string;
  quantity: number;
  stage: PostponementOrderStage;
  leadHoursSaved: number;
  avoidedMismatchCostMajor: number;
  createdAt: string;
  updatedAt: string;
}

export interface MixedLoadSkuLine {
  sku: string;
  warehouseCode: string;
  quantity: number;
  unitWeightKg: number;
  unitVolumeCbm: number;
  hazmat?: boolean;
  reefer?: boolean;
}

export interface MixedLoadCompatibilityResult {
  compatible: boolean;
  warnings: string[];
  totalUnits: number;
  totalWeightKg: number;
  totalVolumeCbm: number;
  weightFillPct: number;
  volumeFillPct: number;
  consolidatedDeliveriesSaved: number;
}

export interface MixedShipmentPlan {
  id: string;
  reference: string;
  customerName: string;
  destinationCity: string;
  equipmentType: "DRY_VAN_53" | "REEFER_40" | "SPRINTER_VAN" | "CONTAINER_40HC";
  lines: MixedLoadSkuLine[];
  totalUnits: number;
  totalWeightKg: number;
  totalVolumeCbm: number;
  weightFillPct: number;
  volumeFillPct: number;
  deliveriesConsolidated: number;
  warnings: string[];
  status: "PLANNED" | "DISPATCHED";
  createdAt: string;
  createdBy: string;
}

export type PreArrivalStage =
  | "NOT_FILED"
  | "PRE_FILED_IN_TRANSIT"
  | "PRE_CLEARED_WHEELS_UP"
  | "HELD";

export interface PreArrivalCustomsFiling {
  id: string;
  shipmentRef: string;
  corridor: string;
  mode: "SEA" | "AIR";
  transitPhase: "ON_WATER" | "IN_THE_AIR";
  broker: string;
  hsCodes: string[];
  hasCommercialInvoice: boolean;
  hasPackingList: boolean;
  hasWaybill: boolean;
  readinessPct: number;
  stage: PreArrivalStage;
  etaHoursRemaining: number;
  portHoursSaved: number;
  avoidedDemurrageMajor: number;
  filedAt: string | null;
  clearedAt: string | null;
}

export interface TacticScorecardItem {
  id: TacticId;
  number: number;
  title: string;
  shortLabel: string;
  status: TacticHealthStatus;
  headlineMetric: string;
  detail: string;
}

export interface TacticsTenantMutations {
  supplierSyncs: SupplierPlanSync[];
  initiatives: SupplierImprovementInitiative[];
  barcodeScans: InventoryBarcodeScan[];
  crossDockSkuKeys: string[];
  postponementWarehouseCodes: string[];
  postponementOrders: PostponementWorkOrder[];
  mixedShipments: MixedShipmentPlan[];
  preArrivalFilings: Record<
    string,
    {
      stage: PreArrivalStage;
      broker?: string;
      hsCodes?: string[];
      hasCommercialInvoice?: boolean;
      hasPackingList?: boolean;
      hasWaybill?: boolean;
      filedAt?: string | null;
      clearedAt?: string | null;
    }
  >;
}

export interface TacticsWorkspaceSnapshot {
  orgName: string;
  currency: string;
  generatedAt: string;
  scorecards: TacticScorecardItem[];
  supplierSyncs: SupplierPlanSync[];
  initiatives: SupplierImprovementInitiative[];
  barcodeScans: InventoryBarcodeScan[];
  inventoryAccuracyPct: number;
  gpsTrackedAssetsCount: number;
  totalFleetAssetsCount: number;
  inTransit: InTransitMetrics;
  postponementCenters: PostponementCenterStatus[];
  postponementOrders: PostponementWorkOrder[];
  totalAvoidedMismatchMajor: number;
  mixedShipments: MixedShipmentPlan[];
  availableInventory: {
    sku: string;
    warehouseCode: string;
    available: number;
    onHand: number;
    handlesHazmat: boolean;
    handlesReefer: boolean;
  }[];
  availableCustomers: string[];
  availableSuppliers: { name: string; code: string; onTimeRatePct: number; damageRatePct: number }[];
  preArrivalFilings: PreArrivalCustomsFiling[];
  totalPortHoursSaved: number;
  totalDemurrageSavedMajor: number;
}

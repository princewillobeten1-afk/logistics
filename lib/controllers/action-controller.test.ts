import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "@/lib/auth";
import {
  handleFrontendLogisticsAction,
  requiredPermissionForIntent,
  verifyFrontendIdentity,
} from "./action-controller";

const ADMIN_USER: SessionUser = {
  id: "user-admin-1",
  orgId: "org-test-1",
  orgName: "Apex Freight Ops",
  email: "admin@apex.test",
  name: "Ada Admin",
  role: "ADMIN",
};

const VIEWER_USER: SessionUser = {
  id: "user-viewer-1",
  orgId: "org-test-1",
  orgName: "Apex Freight Ops",
  email: "viewer@apex.test",
  name: "Victor Viewer",
  role: "VIEWER",
};

const DISPATCHER_USER: SessionUser = {
  id: "user-disp-1",
  orgId: "org-test-1",
  orgName: "Apex Freight Ops",
  email: "dispatcher@apex.test",
  name: "Dara Dispatcher",
  role: "DISPATCHER",
};

test("verifyFrontendIdentity rejects unauthenticated callers with 401 and insufficient roles with 403", async () => {
  const unauth = await verifyFrontendIdentity("READ", async () => null);
  assert.equal(unauth.ok, false);
  if (!unauth.ok) assert.equal(unauth.status, 401);

  const forbidden = await verifyFrontendIdentity(
    "EDIT_SHIPMENT",
    async () => VIEWER_USER,
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.status, 403);

  const allowed = await verifyFrontendIdentity(
    "EDIT_SHIPMENT",
    async () => DISPATCHER_USER,
  );
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.user.email, "dispatcher@apex.test");
});

test("requiredPermissionForIntent maps operational, approval, and support intents accurately", () => {
  assert.equal(requiredPermissionForIntent("NEW_ORDER"), "EDIT_SHIPMENT");
  assert.equal(requiredPermissionForIntent("PLANNING_ROUTING"), "EDIT_SHIPMENT");
  assert.equal(requiredPermissionForIntent("FLEET_OPTIMIZE"), "EDIT_SHIPMENT");
  assert.equal(requiredPermissionForIntent("APPROVAL_DECISION"), "APPROVE");
  assert.equal(requiredPermissionForIntent("SUPPORT_MESSAGE"), "READ");
  assert.equal(requiredPermissionForIntent("SHIPMENT_ASSIST"), "READ");
});

test("handleFrontendLogisticsAction rejects unauthenticated requests with 401 before touching autonomous agent", async () => {
  let called = false;
  const res = await handleFrontendLogisticsAction(
    {
      intent: "NEW_ORDER",
      payload: {
        originCity: "Lagos",
        destinationCity: "Abuja",
        cargoDescription: "Electronics",
      },
    },
    {
      resolveUser: async () => null,
      dispatchAutonomous: async () => {
        called = true;
        throw new Error("Should not be called");
      },
    },
  );

  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test("handleFrontendLogisticsAction enforces RBAC for mutating AUTO intents and approvals", async () => {
  const viewerOrder = await handleFrontendLogisticsAction(
    {
      intent: "AUTO",
      payload: {
        message: "Book 25 cartons of medical kits from Lagos to Abuja",
      },
    },
    {
      resolveUser: async () => VIEWER_USER,
    },
  );
  assert.equal(viewerOrder.ok, false);
  assert.equal(viewerOrder.status, 403);

  const dispatcherApprove = await handleFrontendLogisticsAction(
    {
      intent: "APPROVAL_DECISION",
      payload: {
        token: "tok-123",
        decision: "approve",
      },
    },
    {
      resolveUser: async () => DISPATCHER_USER,
    },
  );
  assert.equal(dispatcherApprove.ok, false);
  assert.equal(dispatcherApprove.status, 403);
});

test("handleFrontendLogisticsAction forwards verified NEW_ORDER and PLANNING_ROUTING payloads to autonomous agent", async () => {
  const forwarded: Array<Record<string, unknown>> = [];

  const orderRes = await handleFrontendLogisticsAction(
    {
      intent: "NEW_ORDER",
      sourceChannel: "WEB_FORM_ORDER",
      payload: {
        customerName: "Kora Retail",
        originCity: "Lagos",
        destinationCity: "Abuja",
        cargoDescription: "Pharma vials",
        weightKg: 350,
        quantity: 12,
        reefer: true,
      },
    },
    {
      resolveUser: async () => DISPATCHER_USER,
      dispatchAutonomous: async (input) => {
        forwarded.push(input as unknown as Record<string, unknown>);
        return {
          intent: "NEW_ORDER",
          startedWork: true,
          orderReference: "PO-2026-9101",
          shipmentReference: "LG-91010",
          shipmentId: "shp-91010",
          delegatedAgents: ["order-management", "shipment-management"],
          draftSaved: false,
          orchestrationSummary: "Delegated.",
          aiWarning: null,
        };
      },
    },
  );

  assert.equal(orderRes.ok, true);
  assert.equal(orderRes.status, 201);
  assert.equal(orderRes.orderReference, "PO-2026-9101");
  assert.equal(orderRes.shipmentReference, "LG-91010");
  assert.equal(orderRes.verifiedUser?.email, "dispatcher@apex.test");
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].orgId, "org-test-1");
  assert.equal(forwarded[0].actorEmail, "dispatcher@apex.test");
  assert.equal(forwarded[0].intentHint, "NEW_ORDER");
  assert.equal(forwarded[0].sourceChannel, "WEB_FORM_ORDER");

  const planRes = await handleFrontendLogisticsAction(
    {
      intent: "PLANNING_ROUTING",
      payload: {
        originCity: "Abuja",
        destinationCity: "Kano",
        preferredMode: "ROAD",
        notes: "Express corridor check",
      },
    },
    {
      resolveUser: async () => ADMIN_USER,
      dispatchAutonomous: async (input) => {
        forwarded.push(input as unknown as Record<string, unknown>);
        return {
          intent: "PLANNING_ROUTING",
          startedWork: true,
          orderReference: "PO-2026-9102",
          shipmentReference: "LG-91020",
          shipmentId: "shp-91020",
          delegatedAgents: ["route-optimization", "fleet-management"],
          draftSaved: false,
          orchestrationSummary: "Planned.",
          aiWarning: null,
        };
      },
    },
  );

  assert.equal(planRes.ok, true);
  assert.equal(planRes.status, 201);
  assert.equal(planRes.shipmentReference, "LG-91020");
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[1].intentHint, "PLANNING_ROUTING");
  assert.equal(forwarded[1].sourceChannel, "WEB_FORM_PLANNING");
});

test("handleFrontendLogisticsAction routes SUPPORT_MESSAGE with verified user identity", async () => {
  const capturedSupportInputs: Array<Record<string, unknown>> = [];

  const res = await handleFrontendLogisticsAction(
    {
      intent: "SUPPORT_MESSAGE",
      payload: {
        channel: "WHATSAPP",
        message: "Book 20 cartons of solar panels from Lagos to Kano",
      },
    },
    {
      resolveUser: async () => VIEWER_USER,
      processSupportTurn: async (input) => {
        capturedSupportInputs.push(input as unknown as Record<string, unknown>);
        return {
          ok: true,
          reply: "Booked under LG-55412.",
          reference: "LG-55412",
          orderReference: "PO-2026-5541",
          shouldEscalate: false,
          autonomous: {
            intent: "NEW_ORDER",
            startedWork: true,
            orderReference: "PO-2026-5541",
            shipmentReference: "LG-55412",
            shipmentId: "shp-55412",
            delegatedAgents: ["order-management", "route-optimization"],
            draftSaved: false,
            orchestrationSummary: null,
            aiWarning: null,
          },
        };
      },
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.shipmentReference, "LG-55412");
  assert.equal(res.orderReference, "PO-2026-5541");
  assert.equal(res.startedWork, true);
  assert.equal(capturedSupportInputs.length, 1);
  assert.equal(capturedSupportInputs[0].orgId, "org-test-1");
  assert.equal(capturedSupportInputs[0].actorEmail, "viewer@apex.test");
  assert.equal(capturedSupportInputs[0].sourceChannel, "WHATSAPP");
});

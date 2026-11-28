import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ONBOARDING_SLIDES,
  clampSlideIndex,
  nextSlideIndex,
  onboardingStorageKeys,
  prevSlideIndex,
  resolveSwipeDirection,
  shouldAutoOpenOnboarding,
} from "./onboarding";

describe("onboarding pure helpers", () => {
  it("defines 4 well-formed slides with unique ids and valid routes", () => {
    assert.equal(ONBOARDING_SLIDES.length, 4);
    const ids = new Set(ONBOARDING_SLIDES.map((s) => s.id));
    assert.equal(ids.size, 4);
    for (const slide of ONBOARDING_SLIDES) {
      assert.ok(slide.title.length > 5);
      assert.ok(slide.description.length > 10);
      assert.ok(slide.primaryRoute.startsWith("/"));
      assert.ok(slide.highlights.length >= 2);
    }
  });

  it("clamps and steps slide indices safely within bounds", () => {
    assert.equal(clampSlideIndex(-3, 4), 0);
    assert.equal(clampSlideIndex(10, 4), 3);
    assert.equal(nextSlideIndex(0, 4), 1);
    assert.equal(nextSlideIndex(3, 4), 3);
    assert.equal(prevSlideIndex(0, 4), 0);
    assert.equal(prevSlideIndex(2, 4), 1);
  });

  it("resolves horizontal swipe gestures left and right", () => {
    assert.equal(resolveSwipeDirection(-60), "next");
    assert.equal(resolveSwipeDirection(60), "prev");
    assert.equal(resolveSwipeDirection(-20), null);
    assert.equal(resolveSwipeDirection(20), null);
    assert.equal(resolveSwipeDirection(Number.NaN), null);
  });

  it("evaluates auto-open rules for login, signup, skip, and autostart", () => {
    // Fresh signup or post-login triggers onboarding unless suppressed or autostart=1
    assert.equal(
      shouldAutoOpenOnboarding({
        hasPendingAuthTrigger: true,
        hasSeenTour: false,
        suppressOnSignIn: false,
        autostartParam: false,
      }),
      true,
    );
    assert.equal(
      shouldAutoOpenOnboarding({
        hasPendingAuthTrigger: true,
        hasSeenTour: true,
        suppressOnSignIn: false,
        autostartParam: false,
      }),
      true,
    );
    // Normal page reload after seeing tour does NOT pop up again
    assert.equal(
      shouldAutoOpenOnboarding({
        hasPendingAuthTrigger: false,
        hasSeenTour: true,
        suppressOnSignIn: false,
        autostartParam: false,
      }),
      false,
    );
    // Suppressed at sign-in stays quiet even on auth trigger
    assert.equal(
      shouldAutoOpenOnboarding({
        hasPendingAuthTrigger: true,
        hasSeenTour: true,
        suppressOnSignIn: true,
        autostartParam: false,
      }),
      false,
    );
    // ?autostart=1 bypasses onboarding modal
    assert.equal(
      shouldAutoOpenOnboarding({
        hasPendingAuthTrigger: true,
        hasSeenTour: false,
        suppressOnSignIn: false,
        autostartParam: true,
      }),
      false,
    );
  });

  it("scopes localStorage keys cleanly per user", () => {
    const keys = onboardingStorageKeys("user-42");
    assert.equal(keys.seenKey, "ct:onboarding:seen:user-42");
    assert.equal(keys.suppressKey, "ct:onboarding:suppress:user-42");
  });
});

"use client";

import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/login/actions";
import { googleSignOut } from "@/lib/google-auth";

export function SignOutButton() {
  async function handleSubmit(formData: FormData) {
    await googleSignOut();
    await signOutAction();
    void formData;
  }

  return (
    <form action={handleSubmit}>
      <button type="submit" className="account-out">
        <LogOut size={13} strokeWidth={1.75} aria-hidden="true" />
        <span>Sign out</span>
      </button>
    </form>
  );
}

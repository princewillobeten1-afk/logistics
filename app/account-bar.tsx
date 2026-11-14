import { signOutAction } from "@/app/login/actions";

const ROLE_HINT: Record<string, string> = {
  VIEWER: "Read only",
  DISPATCHER: "Can create and edit shipments",
  APPROVER: "Can authorise spending",
  ADMIN: "Full access",
};

function initialsFor(name: string | null, email: string): string {
  const source = (name || email).trim();
  if (!source) return "CT";
  const parts = source.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/** Who you are signed in as, and how to stop being signed in. Sits at the
 *  bottom of the rail because it is reference, not navigation. */
export function AccountBar({
  email,
  name,
  role,
}: {
  email: string;
  name: string | null;
  role: string;
}) {
  return (
    <div className="account">
      <div className="account-row">
        <span className="account-avatar" aria-hidden="true">
          {initialsFor(name, email)}
        </span>
        <div className="account-who">
          <strong>{name || email}</strong>
          {name ? <span className="account-email">{email}</span> : null}
        </div>
      </div>
      <div className="account-meta">
        <div className="account-role" title={ROLE_HINT[role] ?? role}>
          {role}
        </div>
        <form action={signOutAction}>
          <button type="submit" className="account-out">
            <span>Sign out</span>
          </button>
        </form>
      </div>
    </div>
  );
}

import { Empty, Panel } from "@/app/components";

export default function CustomerNotFound() {
  return (
    <>
      <div className="page-head">
        <h1>Customer not found</h1>
        <p>No customer in your workspace matches that code.</p>
      </div>
      <Panel title="Not found">
        <Empty
          message="Customer not found"
          hint="Check the customer code or browse the customer directory."
          action={{ label: "Back to customers", href: "/customers" }}
        />
      </Panel>
    </>
  );
}

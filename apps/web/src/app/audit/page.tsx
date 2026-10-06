import { Suspense } from "react";
import { AuditLog } from "@/components/audit/AuditLog";

export default function AuditPage() {
  return (
    <Suspense fallback={null}>
      <AuditLog />
    </Suspense>
  );
}

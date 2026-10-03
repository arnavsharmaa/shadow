import { Suspense } from "react";
import { Overview } from "@/components/overview/Overview";

export default function OverviewPage() {
  return (
    <Suspense fallback={null}>
      <Overview />
    </Suspense>
  );
}

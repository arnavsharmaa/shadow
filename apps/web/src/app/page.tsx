import { Suspense } from "react";
import { TraceExplorer } from "@/components/explorer/TraceExplorer";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <TraceExplorer />
    </Suspense>
  );
}

import { Suspense } from "react";
import { ComparisonView } from "@/components/compare/ComparisonView";

export default async function ComparePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  return (
    <Suspense fallback={null}>
      <ComparisonView traceId={traceId} />
    </Suspense>
  );
}

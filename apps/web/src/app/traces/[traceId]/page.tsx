import { Suspense } from "react";
import { TraceDetail } from "@/components/trace/TraceDetail";

export default async function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  return (
    <Suspense fallback={null}>
      <TraceDetail traceId={traceId} />
    </Suspense>
  );
}

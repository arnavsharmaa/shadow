import { Suspense } from "react";
import { Collections } from "@/components/collections/Collections";

export default function CollectionsPage() {
  return (
    <Suspense fallback={null}>
      <Collections />
    </Suspense>
  );
}

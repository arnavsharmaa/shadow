import { Suspense } from "react";
import { Settings } from "@/components/settings/Settings";

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}

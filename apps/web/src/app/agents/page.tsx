import { Suspense } from "react";
import { AgentStats } from "@/components/agents/AgentStats";

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentStats />
    </Suspense>
  );
}

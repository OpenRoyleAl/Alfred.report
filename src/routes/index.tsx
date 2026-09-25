import { createFileRoute } from "@tanstack/react-router";
import { BriefShell } from "@/components/brief/shell";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <BriefShell />;
}

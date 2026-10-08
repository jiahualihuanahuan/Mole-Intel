import { createFileRoute } from "@tanstack/react-router";
import { DeskPage } from "@/components/desk-page";

export const Route = createFileRoute("/t/$ticker")({
  component: TickerPage,
});

function TickerPage() {
  const { ticker } = Route.useParams();
  return <DeskPage routeTicker={ticker} />;
}

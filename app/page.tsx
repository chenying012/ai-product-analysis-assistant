import ProductAssistant from "@/components/product-assistant";
import { getSetupStatus } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default function Page() {
  return <ProductAssistant initialSetup={getSetupStatus()} />;
}

import { SharedTrace } from "@/components/shared/SharedTrace";

export default async function SharedTracePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedTrace token={token} />;
}

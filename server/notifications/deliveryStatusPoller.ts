import type { Database } from "../db/index.ts";
import { createTextbeltClient, type TextbeltClient } from "../providers/textbeltClient.ts";
import { listReceiptsForStatusPolling, updateReceiptDeliveryStatus } from "./receiptService.ts";

export async function pollTextbeltDeliveryStatuses(
  db: Database,
  client: TextbeltClient = createTextbeltClient(),
): Promise<number> {
  const receipts = listReceiptsForStatusPolling(db, 20);
  let updated = 0;

  for (const receipt of receipts) {
    if (!receipt.providerMessageId) {
      continue;
    }

    const status = await client.getStatus(receipt.providerMessageId);
    if (status.kind === "ok") {
      updateReceiptDeliveryStatus(db, receipt.id, {
        deliveryStatus: status.status,
        response: status.response,
      });
      updated += 1;
    } else {
      updateReceiptDeliveryStatus(db, receipt.id, {
        deliveryStatus: "unknown",
        response: { error: status.error, ...(status.response ?? {}) },
      });
      updated += 1;
    }
  }

  return updated;
}

export function startDeliveryStatusPoller(db: Database): ReturnType<typeof setInterval> {
  return setInterval(() => {
    pollTextbeltDeliveryStatuses(db).catch((error) => {
      console.error(
        "Textbelt delivery status poll failed",
        error instanceof Error ? error.message : error,
      );
    });
  }, 10 * 60 * 1000);
}

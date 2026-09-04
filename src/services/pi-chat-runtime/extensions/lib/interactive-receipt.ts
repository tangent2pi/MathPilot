// Compatibility boundary for runtime extensions. The wire contract itself is
// shared with API and Learning; extensions must not grow a private variant.
export {
  interactiveReceiptBinding,
  parseInteractiveAdmissionReceipt,
} from "@mathpilot/contracts";
export type { InteractiveAdmissionReceipt } from "@mathpilot/contracts";

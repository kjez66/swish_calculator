import { toSvg } from "./qr.js";
import { formatOre } from "../public/shared/money.js";

/**
 * Attach the rendered QR and amount text. Storage keeps only the payload and
 * total because rendering is deterministic. The display page draws `svg` and
 * `amountText` and runs no payment logic of its own.
 * @param {object} roomState
 */
export function render(roomState) {
  if (roomState.state !== "charge") return { ...roomState };
  return {
    ...roomState,
    svg: toSvg(
      roomState.payload,
      `Swish QR-kod för ${formatOre(roomState.totalOre)} kr`,
    ),
    amountText: formatOre(roomState.totalOre),
  };
}

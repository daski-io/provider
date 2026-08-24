import type {
  AdapterResult,
  TaskContext,
} from "../../../core/serviceRegistry/types.js";
import { NOTE_ASSET_TYPE } from "../config.js";
import { validateBody, validateTitle } from "../validation.js";

/// Paid skill: FIRST-TIME provisioning. Returning the `asset` block makes
/// the engine INSERT the assets row and link it to the transaction — the
/// wallet-authorized standard payer becomes the owner. A skill acting on an
/// EXISTING asset must mutate it in place instead and omit `asset` (see the
/// AdapterResult docs).
export async function executeCreateNote(
  _task: TaskContext,
  data: Record<string, unknown>,
): Promise<AdapterResult> {
  const title = validateTitle(data.title);
  if (!title.ok) {
    return { status: "failed", error: title.error.message };
  }
  const bodyInvalid = validateBody(data.body);
  if (bodyInvalid) {
    return { status: "failed", error: bodyInvalid.message };
  }
  const body = typeof data.body === "string" ? data.body : "";
  return {
    status: "completed",
    message: `Note '${title.identifier}' created.`,
    artifacts: [
      {
        name: "note_created",
        data: {
          note: title.identifier,
          title: data.title as string,
          characters: body.length,
        },
      },
    ],
    asset: {
      assetType: NOTE_ASSET_TYPE,
      assetIdentifier: title.identifier,
      assetData: { title: data.title as string, characters: body.length },
    },
  };
}

import type {
  AdapterResult,
  FulfillmentAdapter,
  QuoteError,
  QuoteResult,
  TaskInputAuthorizationContext,
  TaskContext,
} from "../../core/serviceRegistry/types.js";
import { NOTE_PRICE_ATOMIC } from "./config.js";
import { executeCreateNote } from "./skills/createNote.js";
import { executeEcho } from "./skills/echo.js";
import { validateBody, validateMessage, validateTitle } from "./validation.js";

export class DummyAdapter implements FulfillmentAdapter {
  async execute(
    skillId: string,
    task: TaskContext,
    data: Record<string, unknown>,
  ): Promise<AdapterResult> {
    switch (skillId) {
      case "echo":
        return executeEcho(task, data);
      case "create-note":
        return executeCreateNote(task, data);
      default:
        throw new Error(`Unknown skill: ${skillId}`);
    }
  }

  // Only services with an input-required flow (dispatchMode "durable" or
  // conversational skills) implement this; every dummy skill completes
  // in one shot.
  async handleInput(
    _task: TaskContext,
    _inputText: string,
    _data: Record<string, unknown>,
    _authorization: TaskInputAuthorizationContext,
  ): Promise<AdapterResult> {
    return {
      status: "failed",
      message: "Dummy skills do not accept additional input.",
    };
  }

  async cancel(_task: TaskContext): Promise<void> {
    // One-shot skills finish before a cancel can land; nothing to unwind.
    // A service with supplier-side spend must either clean up here or
    // throw CancellationRefusedError to veto (see ServiceModule docs).
  }

  /// Fail-closed pre-payment quote: the gateway will not issue a payment
  /// challenge while `ok: false`, so buyer input errors surface before any
  /// USDC moves. Return the exact amount the buyer will be charged.
  async quote(
    skillId: string,
    serviceArgs: Record<string, unknown>,
  ): Promise<QuoteResult> {
    switch (skillId) {
      case "echo": {
        const invalid = validateMessage(serviceArgs.message);
        return invalid
          ? { ok: false, errors: [invalid] }
          : { ok: true, amount: 0n, currency: "USDC" };
      }
      case "create-note": {
        const errors: QuoteError[] = [];
        const title = validateTitle(serviceArgs.title);
        if (!title.ok) errors.push(title.error);
        const bodyInvalid = validateBody(serviceArgs.body);
        if (bodyInvalid) errors.push(bodyInvalid);
        if (errors.length > 0) return { ok: false, errors };
        return {
          ok: true,
          amount: BigInt(NOTE_PRICE_ATOMIC),
          currency: "USDC",
          notes: [`note identifier will be '${title.ok ? title.identifier : ""}'`],
        };
      }
      default:
        return {
          ok: false,
          errors: [{
            field: "skillId",
            code: "unknown_skill",
            message: `unknown skill: ${skillId}`,
          }],
        };
    }
  }
}

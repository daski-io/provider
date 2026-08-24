import { config } from "../config.js";

export interface LegalMetadata {
  marketplaceTermsUrl: string;
  marketplacePrivacyUrl: string;
  providerLegalName: string;
  providerTermsUrl: string;
  providerPrivacyUrl: string;
}

export const AGENT_AUTHORITY = {
  operatorIsLegalParty: true,
  onMissingAuthority: "stop_and_request_operator_authorization",
  notice:
    "Proceed only if your Operator authorized this Service, the required data disclosures, " +
    "agreement to the linked Daski and Provider Terms, and the total payment.",
} as const;

export const PURCHASE_NOTICE =
  "You are acting as an Agent for an Operator. Proceed only if your Operator has authorized " +
  "you to select this Service, provide the required data, agree to the Daski Terms and " +
  "Provider Terms on its behalf, and authorize the total payment shown. If you lack or cannot " +
  "determine that authority, stop and obtain authorization. By authorizing payment, you " +
  "confirm that authority. The authorization is treated as your Operator's act, and your " +
  "Operator agrees to and is bound by those Terms. The Daski and Provider privacy notices " +
  "describe how personal data is handled.";

export function buildLegalMetadata(): LegalMetadata {
  return {
    marketplaceTermsUrl: config.MARKETPLACE_TERMS_URL,
    marketplacePrivacyUrl: config.MARKETPLACE_PRIVACY_URL,
    providerLegalName: config.PROVIDER_NAME,
    providerTermsUrl: config.PROVIDER_TERMS_URL,
    providerPrivacyUrl: config.PROVIDER_PRIVACY_URL,
  };
}

// Extends the global Env interface with all Worker bindings and secrets.
// Secrets are set via:  wrangler secret put RESEND_API_KEY  (etc.)
// Vars come from wrangler.jsonc [vars] section.

// DOMParser is available at runtime but not in the Workers tsconfig lib.
declare class DOMParser {
  parseFromString(string: string, type: string): Document;
}

interface Env {
  // D1 database binding
  DB: D1Database;
  // Cloudflare Workflow binding
  INSURANCE_WORKFLOW: Workflow;

  // Secrets (wrangler secret put …)
  RESEND_API_KEY: string;
  SAML_PRIVATE_KEY: string; // PEM — SP private key for signing AuthnRequests
  SAML_IDP_CERT: string;    // PEM — IdP cert for verifying SAMLResponse signatures
  JWT_SECRET: string;       // 32+ random bytes, base64-encoded

  // Vars (wrangler.jsonc [vars])
  CFO_EMAIL: string;
  FROM_EMAIL: string;
  APP_BASE_URL: string;
  SAML_IDP_SSO_URL: string;
  SAML_ENTITY_ID: string;
  SAML_ACS_URL: string;
  DEV_MODE: string; // "true" enables /auth/dev-login bypass
}

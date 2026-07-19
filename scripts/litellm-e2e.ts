/**
 * Local integration proof for Agent Studio's real model adapter.
 *
 * The caller supplies a short-lived CAIL JWT and LiteLLM URL. No provider
 * credential is read here.
 */
import { generateText } from "ai";
import { createCailModel } from "../cloudflare/src/lib/cail-model";

const baseUrl = process.env.CAIL_OPENAI_BASE_URL;
const identityJwt = process.env.CAIL_TEST_IDENTITY_JWT;
const model = process.env.CAIL_TEST_MODEL || "cail/fast";
const expectedText = process.env.CAIL_TEST_EXPECTED_TEXT || "AGENT OK";
if (!baseUrl || !identityJwt) {
  throw new Error("CAIL_OPENAI_BASE_URL and CAIL_TEST_IDENTITY_JWT are required");
}

const result = await generateText({
  model: createCailModel({
    env: {
      CAIL_OPENAI_BASE_URL: baseUrl,
      CAIL_MODEL: model,
    },
    identityJwt,
  }),
  prompt: "Reply with exactly AGENT OK",
  maxRetries: 0,
});

if (!result.text.includes(expectedText)) {
  throw new Error(`Unexpected Agent Studio model response: ${result.text}`);
}
console.log(JSON.stringify({ app: "agent-studio", model, ok: true, text: result.text }));

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ECOMMERCE_PRODUCT_IMAGE_INTENT,
  NORTH_STAR_OUTCOME_INTENT,
  creativeOutcomeIntentSchema,
  creativeOutcomeIntentWithPilotSchema,
} from "./outcomes.js";

describe("MCP outcome intent", () => {
  it("accepts the north-star outcome without a model id", () => {
    const parsed = creativeOutcomeIntentSchema.parse(NORTH_STAR_OUTCOME_INTENT);
    assert.equal(parsed.objective, "Create a 15-second product ad");
    assert.equal(parsed.budget_usd, 2);
    assert.ok(!("modelId" in parsed));
  });

  it("accepts the ecommerce product-image dogfood intent", () => {
    const parsed = creativeOutcomeIntentSchema.parse(
      ECOMMERCE_PRODUCT_IMAGE_INTENT,
    );
    assert.equal(parsed.objective, "Ecommerce hero image for this shoe");
    assert.equal(parsed.budget_usd, 0.45);
    assert.ok(!("modelId" in parsed));
  });

  it("accepts a client_reference so the same brief can be ordered again (0.1.4)", () => {
    const parsed = creativeOutcomeIntentSchema.parse({
      ...NORTH_STAR_OUTCOME_INTENT,
      client_reference: "  reorder-2  ",
    });
    assert.equal(parsed.client_reference, "reorder-2");
    assert.equal(
      creativeOutcomeIntentSchema.safeParse({
        ...NORTH_STAR_OUTCOME_INTENT,
        client_reference: "",
      }).success,
      false,
    );
    assert.equal(
      creativeOutcomeIntentSchema.safeParse({
        ...NORTH_STAR_OUTCOME_INTENT,
        client_reference: "x".repeat(201),
      }).success,
      false,
    );
    assert.equal(
      creativeOutcomeIntentSchema.safeParse({
        ...NORTH_STAR_OUTCOME_INTENT,
        client_reference: "caf\u00e9",
      }).success,
      false,
    );
    assert.ok(
      !(
        "client_reference" in
        creativeOutcomeIntentSchema.parse(NORTH_STAR_OUTCOME_INTENT)
      ),
    );
  });

  it("keeps includePilot off the creative intent body", () => {
    const parsed = creativeOutcomeIntentSchema.parse({
      ...NORTH_STAR_OUTCOME_INTENT,
      includePilot: true,
    });
    assert.ok(!("includePilot" in parsed));
    const withPilot = creativeOutcomeIntentWithPilotSchema.parse({
      ...NORTH_STAR_OUTCOME_INTENT,
      includePilot: true,
    });
    assert.equal(withPilot.includePilot, true);
  });
});

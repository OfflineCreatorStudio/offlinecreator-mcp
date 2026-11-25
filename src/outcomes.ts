import * as z from "zod/v4";

export const NORTH_STAR_OUTCOME_INTENT = {
  objective: "Create a 15-second product ad",
  inputs: ["product_photo.jpg"],
  channels: ["tiktok", "instagram_reels"],
  duration_sec: 15,
  budget_usd: 2,
  quality: "high" as const,
  deadline_sec: 90,
  must: ["9:16"],
  avoid: ["text over product"],
  output: "1080x1920 mp4",
};

/** Two-step catalog job. First x402 outcome dogfood — not the five-step north star. */
export const ECOMMERCE_PRODUCT_IMAGE_INTENT = {
  objective: "Ecommerce hero image for this shoe",
  inputs: ["product_photo.jpg", "brand_guide.pdf"],
  budget_usd: 0.45,
  quality: "high" as const,
  deadline_sec: 30,
  must: ["no logo distortion"],
  avoid: ["text over product"],
};

export const creativeOutcomeIntentSchema = z.object({
  objective: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      "What media must exist when the job is done. Do not name a model.",
    ),
  inputs: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
  channels: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
  duration_sec: z.number().positive().max(300).optional(),
  budget_usd: z.number().positive().max(10_000),
  quality: z.enum(["draft", "standard", "high"]).optional(),
  deadline_sec: z.number().positive().max(3600).optional(),
  must: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  avoid: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  output: z.string().trim().min(1).max(200).optional(),
  client_reference: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\x20-\x7E]+$/)
    .optional()
    .describe(
      "Your own order reference (1-200 visible ASCII characters). The same brief from the same account is the same order: executing it again replays the finished result instead of charging again. Send a new client_reference to order the same brief again.",
    ),
  policy: z
    .object({
      allow_providers: z
        .array(z.string().trim().min(1).max(64))
        .max(16)
        .optional(),
      deny_providers: z
        .array(z.string().trim().min(1).max(64))
        .max(16)
        .optional(),
      max_spread_usd: z.number().min(0).max(100).optional(),
      callback_url: z.string().url().max(500).optional(),
      prefer_rail: z
        .enum(["credits", "x402", "stripe_account", "mpp", "card_agent"])
        .optional()
        .describe(
          "Preferred settlement rail. credits is default. x402 is optional USDC. stripe_account is human Checkout. mpp is Stripe's Machine Payments Protocol (Shared Payment Token, $0.50 minimum); it settles only when the deployment enables it, and the quote's accepted_rails reports whether it is available. card_agent (card-network credentials) is reserved, not implemented.",
        ),
      prefer_authorization: z
        .enum(["session", "ap2_mandate", "network_token"])
        .optional()
        .describe(
          "How consent is proven, independent of the rail. session is the authenticated API key or OAuth token and is the only live option. ap2_mandate (AP2) and network_token are reserved.",
        ),
    })
    .optional(),
});

export type CreativeOutcomeIntent = z.infer<typeof creativeOutcomeIntentSchema>;

export const creativeOutcomeIntentWithPilotSchema =
  creativeOutcomeIntentSchema.extend({
    includePilot: z
      .boolean()
      .optional()
      .describe(
        "Include third-party pilot marketplace listings. Default false. Not inferred from an API key.",
      ),
  });

export type CreativeOutcomeIntentWithPilot = z.infer<
  typeof creativeOutcomeIntentWithPilotSchema
>;

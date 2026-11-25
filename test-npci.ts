// test-npci.ts — Real Regulatory Clearing & Settlement Engine Benchmark (NPCI/UPI/OC No.242/2026-27)
import { isDeepStrictEqual } from "node:util";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { parseOrkastDsl } from "./dsl-parser.ts";
import { compileESTree, type ProgramMeta, type RuntimeValue } from "./runtime.ts";
import { computeEconomics } from "./dsl.ts";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env");

interface MerchantRecord {
  id: string;
  turnover: number; // Prev FY turnover in INR (must be <= 4_000_000)
  isNew: boolean;
  isTargetedGeo: boolean; // Tier 3-6, NE, J&K, Ladakh
  isGovtScheme: boolean; // PM SVANidhi / PM Vishwakarma
  hasPriorSubsidy: boolean; // NABARD / duplicate scheme check
  telemetryValid: boolean; // RespAuth geocode + MIC in SID + type/genre
  qrUnits: number;
  soundboxUnits: number;
  activeMonths25Txns: number; // Months in quarter with >= 25 eligible txns (need >= 2)
  minMonthlyEligibleVal: number; // Minimum monthly eligible txn value (need >= 5000)
  prevQuarterVal: number; // Eligible txn value (<= ₹2,000, non-reversed) in prev Q
  currQuarterVal: number; // Eligible txn value in claim Q
}

interface QuarterlyBankClaimInput {
  prevQuarterVol: number;
  currQuarterVol: number;
  merchants: MerchantRecord[];
  pools: { a: number; b: number; c: number };
}

interface SettlementReceipt {
  payoutA: number;
  payoutB: number;
  payoutC: number;
  totalPayout: number;
  disqualifiedCount: number;
}

interface NpciTestCase {
  label: string;
  args: [QuarterlyBankClaimInput];
  expected: SettlementReceipt;
}

const DSL_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    c: {
      type: Type.STRING,
      description:
        "2-space indented Orkast DSL blocks (`set x = expr`, `fn name(a):`, `if cond:`, `elif cond:`, `else:`, `while cond:`, `for x of arr:`, `for i from 0 to n:`, `return expr`). No braces or semicolons.",
    },
  },
  required: ["c"],
};

const SPEC: ProgramMeta & { description: string; tests: NpciTestCase[] } = {
  name: "settleVyapaarSakshamClaim",
  params: [
    {
      name: "claim",
      paramType: `{
        prevQuarterVol: number;
        currQuarterVol: number;
        merchants: Array<{
          id: string;
          turnover: number;
          isNew: boolean;
          isTargetedGeo: boolean;
          isGovtScheme: boolean;
          hasPriorSubsidy: boolean;
          telemetryValid: boolean;
          qrUnits: number;
          soundboxUnits: number;
          activeMonths25Txns: number;
          minMonthlyEligibleVal: number;
          prevQuarterVal: number;
          currQuarterVal: number;
        }>;
        pools: { a: number; b: number; c: number };
      }`,
    },
  ],
  returnType:
    "{ payoutA: number; payoutB: number; payoutC: number; totalPayout: number; disqualifiedCount: number }",
  description: `
Compute quarterly NPCI UPI Vyapaar Saksham (OC No. 242/2026-27) incentive settlement:
1. Iterate over claim.merchants. A merchant is eligible ONLY IF:
   - m.turnover <= 4000000
   - m.telemetryValid is true
   - (m.isTargetedGeo or m.isGovtScheme) is true
   If NOT eligible, increment disqualifiedCount and skip the merchant completely.
2. For each eligible merchant:
   - Component A (New Merchant Onboarding): If m.isNew and not m.hasPriorSubsidy and m.activeMonths25Txns >= 2 and m.minMonthlyEligibleVal >= 5000, add (m.qrUnits * 300) + (m.soundboxUnits * 750) to grossA.
   - Accumulate totalEligibleCurrVal += m.currQuarterVal.
   - If m.isTargetedGeo is true, also accumulate targetGeoPrevVal += m.prevQuarterVal and targetGeoCurrVal += m.currQuarterVal.
3. Component B (Transaction Growth):
   - Requires claim.prevQuarterVol > 0 and ((claim.currQuarterVol - claim.prevQuarterVol) / claim.prevQuarterVol) >= 0.05.
   - If met, grossB = (0.0003 * totalEligibleCurrVal) + (0.5 * 0.0003 * targetGeoCurrVal); otherwise grossB = 0.
4. Component C (Incremental Growth in Targeted Geographies):
   - incTargetVal = Math.max(0, targetGeoCurrVal - targetGeoPrevVal)
   - grossC = 0.002 * incTargetVal
5. Siloed Pool Clamping (Section 4c) & 2-decimal rounding:
   - Round helper: Math.round(x * 100) / 100
   - payoutA = round(Math.min(grossA, claim.pools.a))
   - payoutB = round(Math.min(grossB, claim.pools.b))
   - payoutC = round(Math.min(grossC, claim.pools.c))
   - totalPayout = round(payoutA + payoutB + payoutC)
   - Return { payoutA, payoutB, payoutC, totalPayout, disqualifiedCount }.
  `.trim(),
  tests: [
    // Test 1: Annexure IV Examples 1, 2, 3 combined across 2 merchants
    // M1: Tier-4 Targeted Geo new merchant (1000 QRs, 200 Soundboxes, ₹20 Cr flat value)
    // M2: Tier-1 Govt Scheme (PM SVANidhi) existing merchant (₹30 Cr value, not Targeted Geo)
    // Plus 1 disqualified merchant (turnover > 40L)
    {
      label: "Annexure IV Combined + Disqualification Gate",
      args: [
        {
          prevQuarterVol: 100_000,
          currQuarterVol: 105_000, // exact 5% QoQ growth
          pools: { a: 10_000_000, b: 10_000_000, c: 10_000_000 },
          merchants: [
            {
              id: "M_TIER4_NEW",
              turnover: 1_800_000,
              isNew: true,
              isTargetedGeo: true,
              isGovtScheme: false,
              hasPriorSubsidy: false,
              telemetryValid: true,
              qrUnits: 1000,
              soundboxUnits: 200,
              activeMonths25Txns: 2,
              minMonthlyEligibleVal: 5500,
              prevQuarterVal: 100_000_000,
              currQuarterVal: 200_000_000, // +₹10 Cr incremental targeted value
            },
            {
              id: "M_TIER1_PMSVANIDHI",
              turnover: 900_000,
              isNew: false,
              isTargetedGeo: false,
              isGovtScheme: true, // Eligible in Tier-1 via Central Govt Scheme, no Targeted Geo uplift
              hasPriorSubsidy: false,
              telemetryValid: true,
              qrUnits: 0,
              soundboxUnits: 0,
              activeMonths25Txns: 3,
              minMonthlyEligibleVal: 50_000,
              prevQuarterVal: 250_000_000,
              currQuarterVal: 300_000_000,
            },
            {
              id: "M_DISQUALIFIED_LARGE",
              turnover: 4_500_000, // > ₹40 lakh ceiling -> must be excluded completely
              isNew: true,
              isTargetedGeo: true,
              isGovtScheme: true,
              hasPriorSubsidy: false,
              telemetryValid: true,
              qrUnits: 500,
              soundboxUnits: 100,
              activeMonths25Txns: 3,
              minMonthlyEligibleVal: 20_000,
              prevQuarterVal: 0,
              currQuarterVal: 100_000_000,
            },
          ],
        },
      ],
      expected: {
        payoutA: 450_000, // 1000*300 + 200*750
        payoutB: 180_000, // (0.0003 * 50 Cr = 150k) + (0.00015 * 20 Cr = 30k)
        payoutC: 200_000, // 0.002 * 10 Cr incremental targeted value
        totalPayout: 830_000,
        disqualifiedCount: 1,
      },
    },

    // Test 2: Adversarial Regulatory Traps
    // - Volume growth 4.9% (< 5%) -> zeroes Component B, but Component C still pays
    // - Tier-1 non-scheme merchant -> disqualified
    // - Missing RespAuth MIC/Geocode telemetry -> disqualified
    // - Double-dipping NABARD subsidy -> excluded from Component A, still counts for Component C value
    // - Siloed Pool C cap -> clamped at ₹50,000 despite surplus in Pool A
    {
      label: "Adversarial Traps: 4.9% Vol Gate, Telemetry Gate, Double-Dip & Siloed Pool Clamp",
      args: [
        {
          prevQuarterVol: 1000,
          currQuarterVol: 1049, // 4.9% -> fails Component B threshold
          pools: { a: 5_000_000, b: 5_000_000, c: 50_000 }, // Pool C capped at 50k
          merchants: [
            {
              id: "M_NABARD_DOUBLE_DIP",
              turnover: 1_200_000,
              isNew: true,
              isTargetedGeo: true,
              isGovtScheme: false,
              hasPriorSubsidy: true, // Blocks Component A hardware payout, keeps Component C value
              telemetryValid: true,
              qrUnits: 100,
              soundboxUnits: 50,
              activeMonths25Txns: 3,
              minMonthlyEligibleVal: 10_000,
              prevQuarterVal: 10_000_000,
              currQuarterVal: 60_000_000, // +₹5 Cr incremental -> grossC = ₹1,00,000 -> clamped to ₹50,000
            },
            {
              id: "M_BAD_TELEMETRY",
              turnover: 500_000,
              isNew: true,
              isTargetedGeo: true,
              isGovtScheme: true,
              hasPriorSubsidy: false,
              telemetryValid: false, // Section 9 exclusion
              qrUnits: 50,
              soundboxUnits: 10,
              activeMonths25Txns: 3,
              minMonthlyEligibleVal: 10_000,
              prevQuarterVal: 0,
              currQuarterVal: 50_000_000,
            },
            {
              id: "M_TIER1_NO_SCHEME",
              turnover: 500_000,
              isNew: true,
              isTargetedGeo: false,
              isGovtScheme: false, // Tier-1 without Central Govt scheme -> ineligible
              hasPriorSubsidy: false,
              telemetryValid: true,
              qrUnits: 50,
              soundboxUnits: 10,
              activeMonths25Txns: 3,
              minMonthlyEligibleVal: 10_000,
              prevQuarterVal: 0,
              currQuarterVal: 50_000_000,
            },
          ],
        },
      ],
      expected: {
        payoutA: 0,
        payoutB: 0,
        payoutC: 50_000,
        totalPayout: 50_000,
        disqualifiedCount: 2,
      },
    },
  ],
};

function formatVal(v: RuntimeValue): string {
  return JSON.stringify(v);
}

async function main() {
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const t0 = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFeedback = "";
  const maxAttempts = 5;

  const systemInstruction = [
    "Synthesize function body using ONLY 2-space indented Orkast blocks (no braces `{ }`, no semicolons `;`, no function header).",
    "Grammar: `set x = expr`, `fn helper(a):`, `if cond:`, `elif cond:`, `else:`, `while cond:`, `for x of arr:`, `for i from 0 to n:`, `return expr`.",
    "You may use `and`, `or`, `not`, `==`, `!=`.",
  ].join("\n");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = [
      `Signature: ${SPEC.name}(${SPEC.params.map((p) => `${p.name}: ${p.paramType}`).join(", ")}) -> ${SPEC.returnType}`,
      `Intent:\n${SPEC.description}`,
      `Tests:\n${SPEC.tests.map((t) => `- [${t.label}] ${JSON.stringify(t.args)} => ${formatVal(t.expected)}`).join("\n")}`,
      lastFeedback ? `\nFix:\n${lastFeedback}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const res = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: DSL_SCHEMA,
        temperature: 0.1,
      },
    });

    inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += res.usageMetadata?.candidatesTokenCount ?? 0;

    const payload = JSON.parse(res.text ?? "{}") as { c?: string };
    const parsed = parseOrkastDsl(
      { name: SPEC.name, params: SPEC.params.map((p) => p.name) },
      payload.c ?? ""
    );

    if (parsed.diagnostics.length > 0 || !parsed.estree) {
      lastFeedback = `[PARSE_ERROR] ${parsed.diagnostics.join(" | ")}`;
      console.log(`Attempt ${attempt} parse error:\n${lastFeedback}\n`);
      continue;
    }

    const compiled = compileESTree(SPEC, parsed.estree);
    if (compiled.diagnostics.length > 0 || !compiled.run || !compiled.tsCode) {
      lastFeedback = `[TYPE_ERROR] ${compiled.diagnostics.join(" | ")}`;
      console.log(`Attempt ${attempt} type error:\n${lastFeedback}\n`);
      continue;
    }

    const failures: string[] = [];
    for (const t of SPEC.tests) {
      try {
        const clonedArgs = structuredClone(t.args);
        const actual = compiled.run(...(clonedArgs as unknown as RuntimeValue[]));
        if (!isDeepStrictEqual(actual, t.expected)) {
          failures.push(
            `[WRONG_OUTPUT] test="${t.label}" expected=${formatVal(t.expected)} got=${formatVal(actual)}`
          );
        }
      } catch (err: unknown) {
        failures.push(
          `[RUNTIME_EXCEPTION] test="${t.label}" error="${err instanceof Error ? err.message : String(err)}"`
        );
      }
    }

    if (failures.length === 0) {
      const econ = computeEconomics(inputTokens, outputTokens);
      console.log(`✅ Synthesized ${SPEC.name} on attempt ${attempt}!\n`);
      console.log("=== Synthesized Orkast DSL (Human Audit Blueprint) ===");
      console.log(payload.c);
      console.log("\n=== Compiled TypeScript Receipt (tsc + AST verified) ===");
      console.log(compiled.tsCode);
      console.log("\n=== Token & Cost Economics ===");
      console.table([
        {
          specName: SPEC.name,
          attempts: attempt,
          inputTokens,
          outputTokens,
          ...econ,
          latencyMs: Math.round(performance.now() - t0),
        },
      ]);
      return;
    }

    lastFeedback = failures.join("\n");
    console.log(`Attempt ${attempt} failed assertions:\n${lastFeedback}\n`);
  }

  throw new Error(`Failed to synthesize ${SPEC.name} after ${maxAttempts} attempts.\n${lastFeedback}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
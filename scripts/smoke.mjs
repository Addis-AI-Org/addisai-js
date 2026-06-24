// Live smoke test against the real Addis AI API. Secret-gated; not a PR gate.
//   ADDIS_API_KEY=<sandbox key> node scripts/smoke.mjs
// Exits non-zero on any failure. Keep the surface small and cheap (one paid generate).
import AddisAI from "../dist/index.js";

if (!process.env.ADDIS_API_KEY) {
  console.error("ADDIS_API_KEY not set — skipping smoke (no-op).");
  process.exit(0);
}

const addis = new AddisAI({ logLevel: "error" });
let failed = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m, e) => { failed++; console.log("  ✗", m, "—", e?.message ?? e); };

async function check(label, fn) {
  try { await fn(); } catch (e) { bad(label, e); }
}

const am = await addis.voices.list({ language: "am" }).catch((e) => { bad("voices.list", e); return []; });
am.length ? ok(`voices.list am=${am.length}`) : bad("voices.list", "empty");
const voiceId = (am.find((v) => v.isDefault) ?? am[0])?.id ?? "am-hiwot";

await check("voice.usage", async () => { const u = await addis.voice.usage(); if (typeof u.balance !== "number") throw new Error("no balance"); ok(`usage ${u.formattedBalance}`); });

await check("voice.generate", async () => {
  // tolerate provider cold-start (503/504) for a short while
  let clip;
  for (let i = 0; i < 4; i++) {
    try { clip = await addis.voice.generate({ voiceId, text: "ሰላም", language: "am" }); break; }
    catch (e) { if ((e?.status === 503 || e?.status === 504) && i < 3) { await new Promise((r) => setTimeout(r, 4000)); continue; } throw e; }
  }
  const bytes = await clip.arrayBuffer();
  if (bytes.byteLength <= 0) throw new Error("empty audio");
  ok(`voice.generate ${bytes.byteLength}B`);
});

await check("voice.clips.list", async () => { let n = 0; for await (const _c of addis.voice.clips.list({ language: "am", limit: 1 })) if (++n >= 1) break; ok(`clips iterated ${n}`); });
await check("chat", async () => { const r = await addis.chat.completions.create({ language: "am", messages: [{ role: "user", content: "ሰላም በል" }] }); if (!r.choices[0].message.content) throw new Error("empty"); ok(`chat "${r.choices[0].message.content.slice(0, 30)}"`); });
await check("translate", async () => { const t = await addis.translate.create({ text: "Hello", from: "en", to: "am" }); if (!t.text) throw new Error("empty"); ok(`translate "${t.text}"`); });

console.log(failed ? `\nSMOKE FAILED (${failed})` : "\nSMOKE PASSED");
process.exit(failed ? 1 : 0);

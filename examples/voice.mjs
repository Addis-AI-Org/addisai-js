// Generate speech and save it to disk.
//   ADDIS_API_KEY=... node examples/voice.mjs
import AddisAI from "addisai";

const addis = new AddisAI();

const voices = await addis.voices.list({ language: "am" });
console.log(`${voices.length} Amharic voices. Default: ${voices.find((v) => v.isDefault)?.id}`);

const clip = await addis.voice.generate({
  voiceId: "am-hamen",
  text: "ሰላም፣ እንኳን ወደ አዲስ ኤአይ በደህና መጡ።",
  language: "am",
  outputFormat: "mp3_44100",
});

console.log("clip:", clip.id, clip.durationSeconds, "s");
console.log("cost:", clip.usage?.creditsUsed, clip.usage?.currency);
await clip.toFile("welcome.mp3");
console.log("saved welcome.mp3");

import AddisAI from "addisai";
import { createWriteStream } from "node:fs";
import { once } from "node:events";

const text = process.argv[2];
if (!text) throw new Error('Usage: node examples/realtime.mjs "A complete sentence to speak"');
const language = process.env.ADDIS_VOICE_LANGUAGE ?? "am";
if (!["am", "om", "ti"].includes(language)) {
  throw new Error("ADDIS_VOICE_LANGUAGE must be am, om, or ti.");
}
const addis = new AddisAI(); // ADDIS_API_KEY
let voiceId = process.env.ADDIS_VOICE_ID;
if (!voiceId) {
  const voices = await addis.voices.list({ language });
  const selected = voices.find((voice) => voice.isAvailable && voice.isDefault)
    ?? voices.find((voice) => voice.isAvailable);
  if (!selected) throw new Error(`No available voice for language ${language}.`);
  voiceId = selected.id;
}
const connection = await addis.realtime.connect({ voiceId, language });
const file = createWriteStream("realtime-speech.mp3");
try {
  for await (const bytes of connection.speak(text)) {
    if (!file.write(bytes)) await once(file, "drain");
  }
  file.end();
  await once(file, "finish");
  console.log(connection.lastCompletion?.usage);
} finally {
  connection.close();
  file.destroy();
}

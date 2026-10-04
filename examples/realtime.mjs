import AddisAI from "addisai";
import { createWriteStream } from "node:fs";
import { once } from "node:events";

const addis = new AddisAI(); // ADDIS_API_KEY
const text = process.argv[2];
if (!text) throw new Error('Usage: node examples/realtime.mjs "A complete sentence to speak"');
const language = process.env.ADDIS_VOICE_LANGUAGE ?? "am";
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
